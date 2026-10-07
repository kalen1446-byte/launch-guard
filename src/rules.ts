/**
 * Launch Guard — risk rules for Meteora Dynamic Bonding Curve (DBC) launches.
 *
 * Every rule reads fields from the on-chain PoolConfig account
 * (program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN, state/config.rs)
 * or from live trading data, and returns a flag with a severity and an
 * explanation. Rules describe risky CONFIGURATION, never accuse a token of
 * being a scam.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Flag {
  id: string;
  severity: Severity;
  points: number;
  title: string;
  detail: string;
}

// Mirrors the subset of PoolConfig fields we score (camelCase, as decoded by the DBC SDK).
export interface DbcConfig {
  tokenUpdateAuthority: number; // TokenAuthorityOption
  tokenType: number; // 0 = SPL, 1 = Token-2022
  transferHookProgram?: string | null; // set only for ConfigWithTransferHook
  activationType: number; // 0 = slot, 1 = timestamp
  creatorLiquidityPercentage: number;
  partnerLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  partnerPermanentLockedLiquidityPercentage: number;
  creatorLiquidityVestingInfo?: { isInitialized: number; vestingPercentage: number };
  partnerLiquidityVestingInfo?: { isInitialized: number; vestingPercentage: number };
  poolFees: {
    baseFee: {
      cliffFeeNumerator: bigint;
      firstFactor: number; // number of periods
      secondFactor: bigint; // period frequency
      thirdFactor: bigint; // reduction factor
      baseFeeMode: number; // 0 linear, 1 exponential, 2 rate limiter (deprecated)
    };
  };
  migrationQuoteThreshold: bigint;
  quoteMintDecimals: number;
  quoteIsSol: boolean;
  migrationFeePercentage: number;
  creatorMigrationFeePercentage: number;
  migratedPoolFeeBps: number;
  lockedVestingConfig: { amountPerPeriod: bigint; numberOfPeriod: bigint; cliffUnlockAmount: bigint; cliffDurationFromMigrationTime: bigint };
  preMigrationTokenSupply: bigint;
  postMigrationTokenSupply: bigint;
  fixedTokenSupplyFlag: number;
}

export interface LiveStats {
  totalSupply: bigint;
  top10HolderShare?: number; // 0..1, excluding pool vault
  earlyBundleShare?: number; // share of supply bought in the first 2 slots by <=5 wallets
  creatorSoldShare?: number; // share of creator's bought tokens already sold
}

const FEE_DENOMINATOR = 1_000_000_000n; // MAX_FEE_NUMERATOR = 990_000_000 = 99%
const TOKEN_AUTH = {
  CreatorUpdateAuthority: 0,
  Immutable: 1,
  PartnerUpdateAuthority: 2,
  CreatorUpdateAndMintAuthority: 3,
  PartnerUpdateAndMintAuthority: 4,
};

/** Base fee after the scheduler has fully run (the fee traders pay for the rest of the curve). */
export function finalBaseFeePct(c: DbcConfig): number {
  const b = c.poolFees.baseFee;
  const cliff = b.cliffFeeNumerator;
  const n = BigInt(b.firstFactor);
  let fin: bigint;
  if (b.baseFeeMode === 0) {
    fin = cliff - n * b.thirdFactor;
  } else if (b.baseFeeMode === 1) {
    // cliff * (1 - r/10_000)^n
    let f = Number(cliff);
    const r = 1 - Number(b.thirdFactor) / 10_000;
    f *= Math.pow(r, Number(n));
    fin = BigInt(Math.floor(f));
  } else {
    fin = cliff; // rate limiter: cliff is the base fee
  }
  if (fin < 0n) fin = 0n;
  return (Number(fin) / Number(FEE_DENOMINATOR)) * 100;
}

/** How long (seconds, or slots*0.4s) the elevated fee window lasts. */
export function feeScheduleSeconds(c: DbcConfig): number {
  const b = c.poolFees.baseFee;
  if (b.baseFeeMode > 1) return 0;
  const units = Number(b.secondFactor) * b.firstFactor;
  return c.activationType === 0 ? units * 0.4 : units;
}

export function scoreConfig(c: DbcConfig, live?: LiveStats): { score: number; flags: Flag[] } {
  const flags: Flag[] = [];
  const add = (f: Flag) => flags.push(f);

  // R1 — mint authority retained: supply can be inflated after launch.
  if (c.tokenUpdateAuthority === TOKEN_AUTH.CreatorUpdateAndMintAuthority || c.tokenUpdateAuthority === TOKEN_AUTH.PartnerUpdateAndMintAuthority) {
    add({
      id: "R1_MINT_AUTHORITY",
      severity: "critical",
      points: 40,
      title: "Mint authority kept",
      detail: `${c.tokenUpdateAuthority === 3 ? "Creator" : "Partner"} keeps mint authority — new tokens can be minted after launch, diluting every holder.`,
    });
  }

  // R2 — transfer hook: arbitrary program runs on every transfer (can block sells).
  if (c.transferHookProgram) {
    add({
      id: "R2_TRANSFER_HOOK",
      severity: "critical",
      points: 35,
      title: "Transfer hook enabled",
      detail: `Every transfer calls program ${c.transferHookProgram}. A hook can restrict who is allowed to sell. Verify the hook program before buying.`,
    });
  }

  // R3 — LP that can be withdrawn right after migration.
  // DBC splits migrated liquidity into six buckets that must sum to 100 (process_create_config.rs):
  // partner/creator × {unlocked, permanently locked, vested}. Vesting is its own bucket, not part of
  // the unlocked one. The partner's position goes to config.fee_claimer (the launchpad that created the
  // config); the creator's goes to virtual_pool.creator (migrate_damm_v2_initialize_pool.rs).
  // The program requires at least 10% of liquidity to still be locked one day after migration.
  const creatorFree = c.creatorLiquidityPercentage;
  const partnerFree = c.partnerLiquidityPercentage;
  const locked = 100 - creatorFree - partnerFree;
  if (creatorFree >= 50) {
    add({ id: "R3_UNLOCKED_LP", severity: "high", points: 25, title: "Creator can withdraw most LP", detail: `${creatorFree}% of post-migration liquidity goes to the token creator unlocked and can be pulled right after graduation. Only ${locked}% is locked or vesting.` });
  } else if (creatorFree >= 20) {
    add({ id: "R3_UNLOCKED_LP", severity: "medium", points: 12, title: "Creator can withdraw part of LP", detail: `${creatorFree}% of post-migration liquidity goes to the token creator unlocked.` });
  }
  if (partnerFree >= 50) {
    add({ id: "R3b_PARTNER_LP", severity: "medium", points: 8, title: "Launchpad holds withdrawable LP", detail: `${partnerFree}% of post-migration liquidity goes unlocked to the launchpad that set up this config. Safe only if you trust that launchpad. ${locked}% is locked or vesting (protocol minimum is 10%).` });
  }

  // R4 — fee that stays high after the anti-sniper window.
  const finalFee = finalBaseFeePct(c);
  if (finalFee >= 10) {
    add({ id: "R4_HIGH_FEE", severity: "high", points: 20, title: "High trading fee", detail: `Base fee stays at ${finalFee.toFixed(1)}% after the fee schedule ends. Every buy and sell pays it.` });
  } else if (finalFee >= 3) {
    add({ id: "R4_HIGH_FEE", severity: "medium", points: 8, title: "Elevated trading fee", detail: `Base fee settles at ${finalFee.toFixed(1)}%.` });
  }
  const window = feeScheduleSeconds(c);
  if (window > 3600) {
    add({ id: "R4b_LONG_FEE_WINDOW", severity: "medium", points: 6, title: "Long elevated-fee window", detail: `Anti-sniper fee decays over ${(window / 3600).toFixed(1)} h instead of seconds/minutes.` });
  }

  // R5 — team allocation (locked vesting) relative to supply.
  const lv = c.lockedVestingConfig;
  const teamAlloc = lv.amountPerPeriod * lv.numberOfPeriod + lv.cliffUnlockAmount;
  const supply = c.postMigrationTokenSupply > 0n ? c.postMigrationTokenSupply : c.preMigrationTokenSupply;
  if (supply > 0n && teamAlloc > 0n) {
    const share = Number((teamAlloc * 10_000n) / supply) / 100;
    const shortCliff = lv.cliffDurationFromMigrationTime < 86_400n;
    if (share >= 20) {
      add({ id: "R5_TEAM_ALLOC", severity: shortCliff ? "high" : "medium", points: shortCliff ? 18 : 10, title: "Large team allocation", detail: `${share.toFixed(1)}% of supply is reserved for the creator${shortCliff ? " and starts unlocking within 24h of migration" : ""}.` });
    }
  }

  // R6 — migration fee taken out of graduation liquidity.
  if (c.migrationFeePercentage >= 10) {
    add({ id: "R6_MIGRATION_FEE", severity: "medium", points: 10, title: "Large migration fee", detail: `${c.migrationFeePercentage}% of quote raised is taken at graduation instead of going into liquidity (${c.creatorMigrationFeePercentage}% of that to the creator).` });
  }

  // R7 — very low graduation threshold = thin liquidity after migration.
  if (c.quoteIsSol) {
    const sol = Number(c.migrationQuoteThreshold) / 10 ** c.quoteMintDecimals;
    const shown = sol >= 0.01 ? sol.toFixed(2) : sol.toPrecision(2);
    if (sol < 10) add({ id: "R7_LOW_THRESHOLD", severity: "medium", points: 8, title: "Very low graduation threshold", detail: `Graduates at only ${shown} SOL — post-migration liquidity will be thin and easy to move.` });
  }

  // R8 — mutable metadata (info only).
  if (c.tokenUpdateAuthority !== TOKEN_AUTH.Immutable) {
    add({ id: "R8_MUTABLE_META", severity: "low", points: 3, title: "Metadata can change", detail: "Name, symbol and image can still be updated." });
  }

  // Live behaviour (from Solami trade stream).
  if (live) {
    if ((live.earlyBundleShare ?? 0) >= 0.2) {
      add({ id: "B1_BUNDLE", severity: "high", points: 20, title: "Bundled launch", detail: `${((live.earlyBundleShare ?? 0) * 100).toFixed(0)}% of supply was bought in the first slots by a handful of wallets.` });
    }
    if ((live.top10HolderShare ?? 0) >= 0.5) {
      add({ id: "B2_CONCENTRATION", severity: "high", points: 15, title: "Concentrated holders", detail: `Top 10 wallets hold ${((live.top10HolderShare ?? 0) * 100).toFixed(0)}% of supply.` });
    }
    if ((live.creatorSoldShare ?? 0) >= 0.5) {
      add({ id: "B3_CREATOR_SELLING", severity: "high", points: 15, title: "Creator is selling", detail: `Creator has sold ${((live.creatorSoldShare ?? 0) * 100).toFixed(0)}% of their tokens.` });
    }
  }

  const score = Math.min(100, flags.reduce((s, f) => s + f.points, 0));
  return { score, flags };
}

export function riskLabel(score: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (score >= 60) return "CRITICAL";
  if (score >= 35) return "HIGH";
  if (score >= 15) return "MEDIUM";
  return "LOW";
}
