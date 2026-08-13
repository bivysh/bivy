#!/usr/bin/env node
// Initial-bundle budget (B4b). Fails CI when the web app's entry JS chunk grows
// past a raw/gzipped ceiling, so a heavy import or dependency bump can't silently
// balloon first-load cost. Run after `npm run build -w @bivy/web`.
//
// Budgets carry deliberate headroom over the current size; raise them
// consciously (with the reason in the commit) rather than letting drift ratchet.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import process from "node:process";

const ASSETS = path.resolve("packages/web/dist/assets");

// The entry chunk is `index-<hash>.js` (see vite output). Budget it specifically:
// it is what blocks first paint. Lazy chunks (Terminal-*) load on demand.
const BUDGETS = {
  // Durable ephemeral-start recovery + real bootstrap status add a small amount
  // of first-load orchestration; compressed size remains below the prior cap.
  "index": { rawKB: 830, gzipKB: 230 },
};

let files;
try {
  files = readdirSync(ASSETS).filter((f) => f.endsWith(".js"));
} catch {
  console.error(`check-bundle-size: no build output at ${ASSETS}. Run \`npm run build -w @bivy/web\` first.`);
  process.exit(1);
}

let failed = false;
for (const [prefix, budget] of Object.entries(BUDGETS)) {
  const match = files.find((f) => f.startsWith(`${prefix}-`));
  if (!match) {
    console.error(`check-bundle-size: expected an entry chunk "${prefix}-*.js" — none found.`);
    failed = true;
    continue;
  }
  const abs = path.join(ASSETS, match);
  const raw = statSync(abs).size;
  const gzip = gzipSync(readFileSync(abs)).length;
  const rawKB = Math.round(raw / 1024);
  const gzipKB = Math.round(gzip / 1024);
  const rawOk = rawKB <= budget.rawKB;
  const gzipOk = gzipKB <= budget.gzipKB;
  const mark = rawOk && gzipOk ? "ok  " : "FAIL";
  console.log(`  ${mark} ${match}: ${rawKB}KB raw (budget ${budget.rawKB}), ${gzipKB}KB gzip (budget ${budget.gzipKB})`);
  if (!rawOk || !gzipOk) failed = true;
}

if (failed) {
  console.error("\ncheck-bundle-size: initial-bundle budget exceeded. Trim the entry chunk or raise the budget deliberately.");
  process.exit(1);
}
console.log("check-bundle-size: within budget.");
