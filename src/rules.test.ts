import assert from "node:assert/strict";
import { scoreConfig, riskLabel, finalBaseFeePct, type DbcConfig } from "./rules.ts";

// A "clean" config: immutable metadata, all LP locked, fee decays to 1%, 85 SOL threshold.
const clean: DbcConfig = {
  tokenUpdateAuthority: 1,
  tokenType: 0,
  transferHookProgram: null,
  activationType: 1,
  creatorLiquidityPercentage: 0,
  partnerLiquidityPercentage: 0,
  creatorPermanentLockedLiquidityPercentage: 50,
  partnerPermanentLockedLiquidityPercentage: 50,
  poolFees: { baseFee: { cliffFeeNumerator: 500_000_000n, firstFactor: 49, secondFactor: 1n, thirdFactor: 10_000_000n, baseFeeMode: 0 } },
  migrationQuoteThreshold: 85_000_000_000n,
  quoteMintDecimals: 9,
  quoteIsSol: true,
  migrationFeePercentage: 0,
  creatorMigrationFeePercentage: 0,
  migratedPoolFeeBps: 25,
  lockedVestingConfig: { amountPerPeriod: 0n, numberOfPeriod: 0n, cliffUnlockAmount: 0n, cliffDurationFromMigrationTime: 0n },
  preMigrationTokenSupply: 1_000_000_000n,
  postMigrationTokenSupply: 1_000_000_000n,
  fixedTokenSupplyFlag: 1,
};

// Linear fee: 50% - 49 * 1% = 1%
assert.equal(finalBaseFeePct(clean).toFixed(2), "1.00");
const c = scoreConfig(clean);
assert.equal(c.score, 0, JSON.stringify(c.flags));
assert.equal(riskLabel(c.score), "LOW");

// A "dangerous" config: mint authority + transfer hook + 100% unlocked LP + 15% fee forever.
const bad: DbcConfig = {
  ...clean,
  tokenUpdateAuthority: 3,
  tokenType: 1,
  transferHookProgram: "Hook111111111111111111111111111111111111111",
  creatorLiquidityPercentage: 100,
  creatorPermanentLockedLiquidityPercentage: 0,
  partnerPermanentLockedLiquidityPercentage: 0,
  poolFees: { baseFee: { cliffFeeNumerator: 150_000_000n, firstFactor: 0, secondFactor: 0n, thirdFactor: 0n, baseFeeMode: 0 } },
  migrationQuoteThreshold: 5_000_000_000n,
};
const b = scoreConfig(bad);
const ids = b.flags.map((f) => f.id);
for (const id of ["R1_MINT_AUTHORITY", "R2_TRANSFER_HOOK", "R3_UNLOCKED_LP", "R4_HIGH_FEE", "R7_LOW_THRESHOLD", "R8_MUTABLE_META"]) assert.ok(ids.includes(id), `missing ${id}`);
assert.equal(b.score, 100);
assert.equal(riskLabel(b.score), "CRITICAL");

// Vesting is its own bucket: vested LP never counts as withdrawable.
const vested = scoreConfig({ ...clean, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 40, partnerPermanentLockedLiquidityPercentage: 0, creatorLiquidityVestingInfo: { isInitialized: 1, vestingPercentage: 60 } });
assert.ok(!vested.flags.some((f) => f.id.startsWith("R3")), JSON.stringify(vested.flags));

// Unlocked LP is attributed to who receives it: creator → R3 (high), launchpad/partner → R3b (medium).
const creatorLp = scoreConfig({ ...clean, creatorLiquidityPercentage: 78, creatorPermanentLockedLiquidityPercentage: 22, partnerPermanentLockedLiquidityPercentage: 0 });
assert.ok(creatorLp.flags.some((f) => f.id === "R3_UNLOCKED_LP" && f.severity === "high"));
const partnerLp = scoreConfig({ ...clean, partnerLiquidityPercentage: 78, creatorPermanentLockedLiquidityPercentage: 22, partnerPermanentLockedLiquidityPercentage: 0 });
assert.ok(partnerLp.flags.some((f) => f.id === "R3b_PARTNER_LP") && !partnerLp.flags.some((f) => f.id === "R3_UNLOCKED_LP"));

// Exponential fee: 50% * 0.5^5 = 1.5625%
const expo = finalBaseFeePct({ ...clean, poolFees: { baseFee: { cliffFeeNumerator: 500_000_000n, firstFactor: 5, secondFactor: 1n, thirdFactor: 5000n, baseFeeMode: 1 } } });
assert.equal(expo.toFixed(4), "1.5625");

console.log("✅ rules: all tests passed");
