/**
 * Deep-dive one token: npm run inspect -- <mint>
 * Shows the live mint authority, transfer-hook extension and who can upgrade the hook program.
 */
import { rpc } from "./solana.ts";

const mint = process.argv[2];
if (!mint) throw new Error("usage: npm run inspect -- <mint address>");

const acc: any = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
const info = acc?.value?.data?.parsed?.info;
if (!info) throw new Error("mint not found");
console.log(`Mint ${mint}`);
console.log(`  program          ${acc.value.owner}`);
console.log(`  supply           ${info.supply} (decimals ${info.decimals})`);
console.log(`  mint authority   ${info.mintAuthority ?? "none (revoked)"}`);
console.log(`  freeze authority ${info.freezeAuthority ?? "none"}`);

for (const ext of info.extensions ?? []) {
  if (ext.extension === "transferHook") {
    const hook = ext.state?.programId;
    console.log(`  transfer hook    program ${hook ?? "none (cleared)"}, authority ${ext.state?.authority ?? "none"}`);
    if (hook) {
      const prog: any = await rpc("getAccountInfo", [hook, { encoding: "jsonParsed" }]);
      const pd = prog?.value?.data?.parsed?.info?.programData;
      console.log(`  hook program     owner ${prog?.value?.owner}, executable ${prog?.value?.executable}`);
      if (pd) {
        const data: any = await rpc("getAccountInfo", [pd, { encoding: "jsonParsed" }]);
        const up = data?.value?.data?.parsed?.info?.authority;
        console.log(`  hook upgradeable ${up ? `yes, by ${up}` : "no (immutable)"}`);
      }
    }
  } else if (ext.extension === "tokenMetadata") {
    console.log(`  metadata         ${ext.state?.name} (${ext.state?.symbol}), update authority ${ext.state?.updateAuthority ?? "none"}`);
  } else {
    console.log(`  extension        ${ext.extension}`);
  }
}
