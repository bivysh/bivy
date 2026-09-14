#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function compareVersions(left, right) {
  const a = left.split(/[.-]/).slice(0, 3).map(Number);
  const b = right.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
function satisfies(version, range) {
  if (!VERSION_RE.test(version) || typeof range !== "string") return false;
  return range.split(/\s+/).every((clause) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(clause);
    if (!match) return false;
    const comparison = compareVersions(version, match[2]);
    return match[1] === ">=" ? comparison >= 0 : match[1] === "<=" ? comparison <= 0 : match[1] === ">" ? comparison > 0 : match[1] === "<" ? comparison < 0 : comparison === 0;
  });
}

const root = path.resolve(new URL("..", import.meta.url).pathname);
const matrixPath = path.join(root, "certification/agents.json");
const generatedPath = path.join(root, "src/certification/generated.ts");
const docsPath = path.join(root, "docs/supported-agents.md");
const fixturesDir = path.join(root, "test/fixtures/certification");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
const REQUIRED = ["probe-install", "auth-handoff", "first-turn", "structured-streaming", "approval", "denial", "cancellation", "resume", "attachments", "token-refresh", "malformed-output", "version-drift"];

function validate() {
  const errors = [];
  if (matrix.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (JSON.stringify(matrix.requiredScenarios) !== JSON.stringify(REQUIRED)) errors.push("requiredScenarios must contain the canonical ordered scenario set");
  const ids = new Set();
  for (const agent of matrix.agents ?? []) {
    if (!agent.id || ids.has(agent.id)) errors.push(`duplicate/missing agent id: ${agent.id}`);
    ids.add(agent.id);
    if (!VERSION_RE.test(agent.upstream?.pinnedVersion ?? "")) errors.push(`${agent.id}: invalid pinnedVersion`);
    if (!satisfies(agent.upstream?.pinnedVersion ?? "", agent.upstream?.supportedRange)) errors.push(`${agent.id}: pin is outside supportedRange`);
    if (agent.executionMode !== "protocol") errors.push(`${agent.id}: initial Supported set must use a governed protocol mode`);
    for (const key of ["toolInterception", "modelSelection", "resume", "attachments", "cancellation", "structuredStreaming", "tokenRefresh"]) {
      if (!agent.capabilities?.includes(key)) errors.push(`${agent.id}: missing capability ${key}`);
    }
    if (!agent.platforms?.length || !agent.probe?.command || !agent.install?.command) errors.push(`${agent.id}: platforms/probe/install are required`);
    const fixturePath = path.join(fixturesDir, `${agent.id}.json`);
    let fixture;
    try { fixture = JSON.parse(readFileSync(fixturePath, "utf8")); } catch (error) { errors.push(`${agent.id}: unreadable fixture (${error.message})`); continue; }
    if (fixture.agentId !== agent.id) errors.push(`${agent.id}: fixture id mismatch`);
    for (const scenario of REQUIRED) if (!Array.isArray(fixture.scenarios?.[scenario]) || fixture.scenarios[scenario].length === 0) errors.push(`${agent.id}: fixture missing ${scenario}`);
    if (JSON.stringify(fixture).includes(fixture.secretSentinel) && JSON.stringify(fixture.scenarios).includes(fixture.secretSentinel)) errors.push(`${agent.id}: fixture leaks its secret sentinel`);
  }
  if (ids.size !== 4 || !["claude-code-sdk", "codex-approvals", "pi", "opencode"].every((id) => ids.has(id))) errors.push("initial certification set must contain exactly Claude Code, governed Codex, Pi, and OpenCode ACP");
  if (errors.length) throw new Error(`Certification matrix invalid:\n- ${errors.join("\n- ")}`);
}

function generatedSource() {
  const rows = matrix.agents.map((agent) => {
    const capabilities = agent.capabilities.filter((capability) => ["toolInterception", "modelSelection", "resume"].includes(capability));
    return `    { id: ${JSON.stringify(agent.id)}, status: ${JSON.stringify(agent.status)}, executionMode: ${JSON.stringify(agent.executionMode)}, pinnedVersion: ${JSON.stringify(agent.upstream.pinnedVersion)}, capabilities: ${JSON.stringify(capabilities)} },`;
  }).join("\n");
  return `// SPDX-License-Identifier: AGPL-3.0-only\n// Generated from certification/agents.json by scripts/certification.mjs. Do not edit.\nexport const CERTIFICATION_MATRIX = {\n  schemaVersion: 1,\n  agents: [\n${rows}\n  ]\n} as const;\n`;
}

function generatedDocs() {
  const rows = matrix.agents.map((agent) => `| ${agent.name} | \`${agent.id}\` | \`${agent.upstream.supportedRange}\` (pin \`${agent.upstream.pinnedVersion}\`) | ${agent.platforms.join(", ")} | \`${agent.executionMode}\` | ${agent.capabilities.join(", ")} |`).join("\n");
  return `# Release-tested agent capability sets\n\n<!-- Generated by scripts/certification.mjs from certification/agents.json. Do not edit. -->\n\n**Supported** means Bivy maintains a wrapper for an agent. This matrix is narrower: it records the pinned adapter versions and capability set that were release-tested for richer fidelity claims such as governed protocol mode, model selection, resume, attachments, cancellation, structured streaming, and token refresh. A missing, suspended, wrong-mode, stale-version, or capability-incomplete matrix entry does not make the wrapper unsupported; it marks that configured path as adapter-tested rather than release-tested.\n\n| Agent | Runtime id | Validated range | Platforms | Required mode | Release-tested capabilities |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\nDeterministic normal-CI fixtures exercise: ${matrix.requiredScenarios.join(", ")}. Live credentials are tested only by explicit workflow dispatch. Nightly latest-upstream checks report drift for review and never update this file or the production pins.\n`;
}

function writeOrCheck(check) {
  for (const [file, expected] of [[generatedPath, generatedSource()], [docsPath, generatedDocs()]]) {
    if (check) {
      const actual = readFileSync(file, "utf8");
      if (actual !== expected) throw new Error(`${path.relative(root, file)} is stale; run pnpm run certification:generate`);
    } else writeFileSync(file, expected);
  }
}

async function latest() {
  const rows = [];
  for (const agent of matrix.agents) {
    try {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(agent.upstream.package)}/latest`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const latestVersion = (await response.json()).version;
      rows.push({ agent: agent.id, pinned: agent.upstream.pinnedVersion, latest: latestVersion, inRange: satisfies(latestVersion, agent.upstream.supportedRange) });
    } catch (error) { rows.push({ agent: agent.id, pinned: agent.upstream.pinnedVersion, latest: "unknown", inRange: false, error: error.message }); }
  }
  const report = [`# Latest upstream release-tested drift`, "", "| Agent | Release-tested pin | Latest | In validated range |", "| --- | --- | --- | --- |", ...rows.map((row) => `| ${row.agent} | ${row.pinned} | ${row.latest} | ${row.inRange ? "yes" : "**no — review required**"} |`), "", "This report is informational and does not alter wrapper support."].join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`, { flag: "a" });
}

function live() {
  if (process.env.BIVY_CERTIFICATION_LIVE !== "1") throw new Error("Live certification requires BIVY_CERTIFICATION_LIVE=1 (use the opt-in workflow)");
  const selected = new Set((process.env.BIVY_LIVE_AGENT_IDS ?? "").split(",").filter(Boolean));
  if (!selected.size) throw new Error("Set BIVY_LIVE_AGENT_IDS to an explicit comma-separated subset");
  for (const agent of matrix.agents.filter((entry) => selected.has(entry.id))) {
    const result = spawnSync(agent.probe.command, agent.probe.args, { encoding: "utf8", timeout: 30_000, env: process.env });
    if (result.status !== 0) throw new Error(`${agent.id}: live probe failed (output redacted)`);
    console.log(`${agent.id}: live probe passed; credential and command output redacted`);
  }
}

validate();
const mode = process.argv[2] ?? "--check";
if (mode === "--generate") writeOrCheck(false);
else if (mode === "--check") writeOrCheck(true);
else if (mode === "--latest") await latest();
else if (mode === "--live") live();
else throw new Error(`Unknown mode ${mode}`);
