import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../bin/bivy.mjs", import.meta.url), "utf8");

assert.match(source, /Sign in to a model now so your first task can run\?/, "model auth belongs in activation");
assert.match(source, /Check first-task readiness below/, "setup must separate node startup from reply readiness");
assert.match(source, /model .*not configured — run 'bivy login'/, "setup must name model remediation instead of calling an unauthenticated node ready");
assert.match(source, /explain this repository and identify one low-risk improvement/, "setup should provide a useful low-risk starter task");

console.log("setup-contract: all tests passed");
