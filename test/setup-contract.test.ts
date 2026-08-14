import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../bin/bivy.mjs", import.meta.url), "utf8");

assert.match(source, /Sign in to a model now so your first task can run\?/, "model auth belongs in activation");
assert.match(source, /Check first-task readiness below/, "setup must separate node startup from reply readiness");
assert.match(source, /model .*not configured — run 'bivy login'/, "setup must name model remediation instead of calling an unauthenticated node ready");
assert.match(source, /In the terminal:/, "setup should offer the selected agent's terminal flow");
assert.match(source, /Or start in chat:/, "setup should offer the remote app as an equal starting point");
assert.doesNotMatch(source, /Starter task:/, "setup should not promote a canned bivy exec task");
assert.match(source, /RECOMMENDED_SETUP_AGENT_IDS = new Set\(\["claude-code-sdk", "codex-approvals"\]\)/, "setup recommends the two certified agents");
assert.match(source, /\{ key: "m", label: "More agents…" \}/, "other agents stay available behind an explicit secondary choice");
assert.match(source, /runtimeId: "codex-approvals"/, "setup uses the governed Codex adapter rather than the legacy exec path");
assert.match(source, /if \(runtimeId === "codex"\) runtimeId = "codex-approvals";/, "re-running setup migrates the former Codex default");
assert.doesNotMatch(source, /Pi \(default/, "Pi is no longer presented as the strategy default");
assert.match(source, /function firstSetupWorkspace\(config\)/, "setup has one repository-aware workspace selection path");
assert.match(source, /rev-parse", "--show-toplevel"/, "fresh setup preselects the repository it was launched from");

console.log("setup-contract: all tests passed");
