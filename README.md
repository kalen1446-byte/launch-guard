---
title: Launch Guard
emoji: 🛡️
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Launch Guard: safety layer for Meteora DBC

**Know what a launch allows before you buy.**

Every token on Meteora's **Dynamic Bonding Curve (DBC)** is created from an on-chain config. That config decides what happens at graduation: who gets the liquidity, whether new tokens can be minted, whether a program runs on every transfer. Launch Guard finds every new DBC pool through **Solami**, decodes its config and scores it with rules taken from the DBC program source.

> Launch Guard flags risky **configuration**. It does not label any token a scam. Not financial advice.

| | |
|---|---|
| Live dashboard | https://launch-guard.onrender.com |
| How it works | https://launch-guard.onrender.com/about |
| Telegram alerts | https://t.me/launchguard_alerts |
| Pitch video | https://www.youtube.com/watch?v=INSo5YNHfa4 |
| Demo video | https://www.youtube.com/watch?v=jiOw9m0HQbY |

## What it found: State of DBC (Oct 7, 2026)

Scored across every DBC config and pool on mainnet, weighted by launches ([data](data/state-of-dbc-2026-10-07.json)):

- **1.76M** launches from **542K** configs
- **42%** let the creator withdraw at least half of the LP at graduation
- **~10.5K** gave the creator or launchpad mint authority
- The largest config (175,599 launches) scores **0**: the risk is in the settings, not in DBC

## Four ways to use it

| Surface | How |
|---|---|
| Live dashboard | Every new DBC launch scored within seconds, with the reason for each flag |
| Check any token | Paste a mint or pool address, even for old launches: `/?check=<address>` |
| Telegram | Add the bot to a group and type `/check <address>`; critical launches go to the alerts channel |
| Public API | `GET /api/check/<address>`, JSON for bots, wallets and launchpads |

## What only Launch Guard shows

| | Dexscreener | RugCheck | GoPlus | Token Sniffer | Launch Guard |
|---|---|---|---|---|---|
| Reads the DBC launch config | — | — | Token fields only | — | ✓ |
| Creator LP after graduation, known in advance | — | Only after LP exists | — | — | Exact % per launch |
| Migration fee, fee schedule, graduation threshold | — | — | — | — | ✓ |
| Config score for every new DBC launch | New pairs, no score | — | — | — | Within ~15 s |
| Which launchpads ship risky configs | — | — | — | — | ✓ |
| Report on all 1.76M DBC launches | — | — | — | — | ✓ |

DBC launch-rule features only, from each tool's public pages, October 2026.

## How it works

1. **Find new pools.** Every DBC pool stores its activation point (slot or unix time) at offset 296. Every 15 s, one Solami `getProgramAccountsV2` query with a `memcmp` filter on that field returns only the pools created in the last few minutes. No swap transaction is ever opened. Every ~5 min a wider sweep re-checks the last hour, so a pool missed by a failed scan is picked up later.
2. **Read the config.** Pool → config account, decoded with the DBC IDL.
3. **Apply 8 rules.** Each rule maps to a field and check in the DBC Rust source.
4. **Score 0–100.** Low, medium, high or critical, with a plain-English reason.
5. **Deliver.** Dashboard stream, Telegram alerts and `/check`, JSON API.

## Rules

| Rule | Finding | Why it matters |
|---|---|---|
| R1 | Mint authority kept | New tokens can be minted and sold into the pool. Survives graduation. |
| R2 | Transfer hook | A program runs on every transfer and can restrict selling while the token is on the curve. |
| R3 | Creator can withdraw LP | Unlocked creator LP can be pulled right after graduation. |
| R3b | Launchpad holds LP | Unlocked partner LP goes to the launchpad's fee claimer. |
| R4 | High or long fee | Base fee stays high after the anti-sniper window. |
| R5 | Large team allocation | 20%+ of supply reserved for the creator, worse with a short cliff. |
| R6 | Large migration fee | Raised quote leaves at graduation instead of becoming liquidity. |
| R7 | Low graduation threshold | Thin post-migration liquidity. |
| R8 | Mutable metadata | Name, symbol and image can still change. |

Rules live in [`src/rules.ts`](src/rules.ts) with tests in [`src/rules.test.ts`](src/rules.test.ts). Program: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`.

## Capture rate

`npm run capture` compares the live server with the chain: it fetches every DBC pool whose activation point falls in a time window and checks which ones the server scored. On Oct 10, 2026 (185-minute window): **326 launches on mainnet, 324 scored, 99.4%**, about 2,500 launches a day. The backfill sweep was added after this measurement to recover misses like these two.

## How Solami is used

| Solami RPC call | Used for |
|---|---|
| `getProgramAccountsV2` + `memcmp` on `activation_point` | Live feed of new pools, backfill sweep, capture check |
| `getProgramAccountsV2` (paginated, `dataSlice`) | State of DBC report across every config and pool |
| `getAccountInfo` | Config decoding, token name and type |
| `getSignaturesForAddress` | Launch transaction for each pool |

## Run it

Requires Node.js 20+ and a Solami API key.

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm run test:rules          # rule engine tests
npm run poolscan            # one scan: pools created in the last few minutes
npm start                   # watcher + dashboard + API on http://localhost:8787
npm run dev                 # same, without the Telegram bot
npm run capture             # capture rate of the live server (last 60 min)
npm run capture:4h          # same, last 4 hours
npm run report              # State of DBC report
```

### API

| Route | Returns |
|---|---|
| `GET /api/check/:address` | Score for any DBC mint or pool |
| `GET /api/launches?limit=100` | Latest scored launches |
| `GET /api/launch/:pool` | One launch with all flags |
| `GET /api/stats` | Last-24h counts by risk label and flag |
| `GET /api/stream` | Server-Sent Events, one message per new launch |

## License

MIT
