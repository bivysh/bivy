// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const cli = fs.readFileSync(new URL("../bin/bivy.mjs", import.meta.url), "utf8");

assert.match(server, /app\.get\("\/api\/activation\/readiness"/, "node exposes authoritative readiness");
assert.match(server, /probeAnthropicAccess/, "node validates Anthropic API access instead of key presence only");
assert.match(server, /ok: repositoryChosen/, "GitHub login alone must not claim that a target repository is ready");
assert.doesNotMatch(server, /ok: repositoryChosen \|\|/, "repository readiness must not fall back to generic GitHub authentication");
assert.match(cli, /\/api\/activation\/readiness/, "setup and doctor consume node readiness");
assert.match(cli, /first task.*blocked by the stage above/, "setup reports blocked first-task readiness honestly");
assert.match(cli, /repository.*not selected or access could not be verified/, "doctor names the repository blocker");

console.log("activation live readiness contract: passed");
