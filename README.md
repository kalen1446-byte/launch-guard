# Launch Guard — Safety Layer for Meteora DBC

Real-time risk scoring for every token launched on Meteora's **Dynamic Bonding Curve (DBC)**.
Launch Guard streams new DBC pools through **Solami**, decodes each pool's on-chain config and
scores it with audit-grade rules derived from the DBC program source.

> Launch Guard flags risky **configuration**. It does not label any token a scam.

## What it checks

| Rule | Signal | Why it matters |
|---|---|---|
| R1 | Mint authority retained (`CreatorUpdateAndMintAuthority` / `PartnerUpdateAndMintAuthority`) | Supply can be inflated after launch |
| R2 | Token-2022 transfer hook | Arbitrary program runs on every transfer; can restrict selling |
| R3 | Withdrawable post-migration LP (not locked, not vested) | Liquidity can be pulled right after graduation |
| R4 | High base fee after the fee schedule / long fee window | Every trade pays it |
| R5 | Large team allocation with short cliff | Early unlock pressure |
| R6 | Large migration fee | Raised quote leaves instead of becoming liquidity |
| R7 | Very low graduation threshold | Thin post-migration liquidity |
| R8 | Mutable metadata | Name / image can change |
| B1–B3 | Bundled first slots, holder concentration, creator selling | Live behaviour (Solami market data) |

Rules live in [`src/rules.ts`](src/rules.ts) with unit tests in [`src/rules.test.ts`](src/rules.test.ts).
Field offsets and enums reference `programs/dynamic-bonding-curve/src/state/config.rs` (program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`).

## How Solami is used

| Solami product | Used for |
|---|---|
| RPC WebSocket (`logsSubscribe`) | Live stream of DBC program logs → detect every new pool the moment it lands |
| RPC (`getTransaction`) | Resolve the launch transaction, including CPI launches from launchpads and address lookup tables |
| RPC (`getProgramAccounts` with `dataSlice`) | "State of DBC Launches" report across every config and pool on mainnet |

## Run it

Requires Node.js 20+ and a Solami API key ([sign up](https://solami.dev/signup?ref=st-earn-sep-26)).

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# put your Solami RPC and WebSocket URLs in .env
npm run test:rules          # unit tests for the rule engine
npm run check               # smoke test: score the latest launches on mainnet
npm start                   # live watcher + API on http://localhost:8787
npm run report              # State of DBC Launches → data/report.json
```

### API

| Route | Returns |
|---|---|
| `GET /api/launches?limit=100` | Latest scored launches |
| `GET /api/launch/:pool` | One launch with all flags |
| `GET /api/stats` | Last-24h counts by risk label and flag |
| `GET /api/stream` | Server-Sent Events, one message per new launch |
| `GET /` | Live dashboard |

## License

MIT
