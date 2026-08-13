// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";

let base = process.env.BIVY_VOCAB_BASE || "HEAD^";
const runDiff = () => spawnSync("git", ["diff", "--unified=0", "--no-ext-diff", base, "HEAD", "--", "packages/web/src", "bin", "README.md", "docs"], { encoding: "utf8" });
let diff = runDiff();
// actions/checkout intentionally uses a one-commit clone. Fetch only the named
// event base when its parent object is absent; no workflow permission is needed.
if (diff.status !== 0 && process.env.GITHUB_BASE_REF) {
  const fetched = spawnSync("git", ["fetch", "--no-tags", "--depth=1", "origin", process.env.GITHUB_BASE_REF], { encoding: "utf8" });
  if (fetched.status === 0) {
    base = "FETCH_HEAD";
    diff = runDiff();
  }
}
if (diff.status !== 0) {
  process.stderr.write(diff.stderr || `Could not compare customer copy with ${base}.\n`);
  process.exit(2);
}

// These are product-language checks, not internal identifier migrations. A
// compatibility/API mention can opt out on its line with `vocabulary-compat`.
const prohibited = [
  [/\bwork queue\b/i, "Runs"],
  [/\boutcome reports?\b/i, "Receipt"],
  [/\brouting labels?\b/i, "Machine selection or routing rule"],
  [/\bephemeral config(?:uration)?\b/i, "isolated Machine profile"],
  [/["'`]Nodes["'`]|>\s*Nodes\s*</, "Machines"],
];

let file = "";
let line = 0;
const failures = [];
for (const raw of diff.stdout.split("\n")) {
  if (raw.startsWith("+++ b/")) {
    file = raw.slice(6);
    continue;
  }
  const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
  if (hunk) {
    line = Number(hunk[1]);
    continue;
  }
  if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
  const text = raw.slice(1);
  if (!text.includes("vocabulary-compat")) {
    for (const [pattern, replacement] of prohibited) {
      if (pattern.test(text)) failures.push(`${file}:${line}: use “${replacement}” in customer-facing copy: ${text.trim()}`);
    }
  }
  line += 1;
}

if (failures.length) {
  process.stderr.write(`Product vocabulary check failed:\n${failures.join("\n")}\n\nFor a required legacy/API term, add “vocabulary-compat” on that line with a short reason.\n`);
  process.exit(1);
}
process.stdout.write("Product vocabulary check passed.\n");
