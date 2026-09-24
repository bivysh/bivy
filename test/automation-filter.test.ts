// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutomationFilterError, runAutomationFilter, webhookFilterInput } from "../src/automation-filter.js";
import { passWebhookFilter } from "../src/automation-filter-gate.js";
import { decodeAutomationTemplate, encodeAutomationTemplate, parseAutomationFilter } from "../src/automation-template.js";
import { parseAutomationConfig } from "../src/automation-config.js";

const input = webhookFilterInput({ pull_request: { draft: true }, text: "$(touch /not-executed)" }, "delivery-123");
const filter = (code: string) => ({ command: [process.execPath, "-e", code], cwd: os.tmpdir(), timeoutSeconds: 5 });

test("JSON stdin, explicit decisions, and bounded diagnostics", async () => {
  const result = await runAutomationFilter(filter(`
    let s = ''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => {
      const i = JSON.parse(s);
      if(i.version !== 1 || i.delivery.id !== 'delivery-123') process.exit(1);
      console.error('checked');
      console.log(JSON.stringify({decision: i.event.payload.pull_request.draft ? 'skip' : 'accept', reason: 'Draft PR'}));
    });
  `), input);
  assert.deepEqual(result, { decision: "skip", reason: "Draft PR", diagnostics: "checked\n" });
  assert.equal((await runAutomationFilter(filter(`console.log('{"decision":"accept"}')`), input)).decision, "accept");
});

test("no inherited secrets or Node injection options; arguments are not shell-expanded", async () => {
  process.env.BIVY_FILTER_TEST_SECRET = "secret";
  try {
    const config = filter(`
      if(process.env.BIVY_FILTER_TEST_SECRET || process.env.NODE_OPTIONS || process.env.HOME) process.exit(1);
      console.log(JSON.stringify({decision:'accept', reason:process.argv[1]}));
    `);
    config.command.push("$(echo injected)");
    const result = await runAutomationFilter(config, input);
    assert.equal(result.decision, "accept");
    assert.equal(result.reason, "$(echo injected)");
  } finally { delete process.env.BIVY_FILTER_TEST_SECRET; }
});

test("errors fail closed", async () => {
  for (const code of [
    "process.exit(2)", "console.log('not JSON')", "console.log('{}')",
    `console.log('{"decision":"maybe"}')`, `console.log('{"decision":["accept"]}')`,
    `console.log('{"decision":"accept","instructions":"override"}')`,
    `console.log(JSON.stringify({decision:'skip',reason:'x'.repeat(501)}))`,
    `process.stdout.write('x'.repeat(17000))`, `process.stderr.write('x'.repeat(17000))`,
  ]) await assert.rejects(runAutomationFilter(filter(code), input), AutomationFilterError);
  await assert.rejects(runAutomationFilter({ ...filter(""), command: ["/missing-bivy-filter"] }, input), /Could not start/);
  await assert.rejects(runAutomationFilter({ ...filter(""), cwd: "/missing-bivy-directory" }, input), /Could not start/);
  await assert.rejects(runAutomationFilter(filter(""), webhookFilterInput({ x: "x".repeat(256 * 1024) }, "id")), /input exceeds/);
});

test("timeouts and cancellation stop filters", async () => {
  await assert.rejects(runAutomationFilter({ ...filter("setInterval(()=>{},1000)"), timeoutSeconds: 1 }, input), /timed out/);
  const controller = new AbortController();
  const running = runAutomationFilter(filter("setInterval(()=>{},1000)"), input, controller.signal);
  controller.abort();
  await assert.rejects(running, /cancelled/);
  await assert.rejects(runAutomationFilter(filter(""), input, controller.signal), /cancelled/);
});

test("POSIX timeout kills descendants, not only the filter parent", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-filter-tree-"));
  const marker = path.join(dir, "escaped");
  try {
    const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1800)`;
    const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'inherit'}); setInterval(()=>{},1000)`;
    await assert.rejects(runAutomationFilter({ ...filter(parentCode), timeoutSeconds: 1 }, input), /timed out/);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("configuration validation and encrypted-template roundtrip", () => {
  const f = parseAutomationFilter({ command: ["python3", "filter.py"], cwd: "/srv/trusted-filters" });
  assert.equal(f.timeoutSeconds, 5);
  assert.deepEqual(decodeAutomationTemplate(encodeAutomationTemplate("instructions", {}, f)).filter, f);
  for (const bad of [null, {}, { ...f, command: "echo accept" }, { ...f, command: [] }, { ...f, cwd: "relative" }, { ...f, timeoutSeconds: 0 }, { ...f, timeoutSeconds: 61 }, { ...f, timeoutSeconds: "5" }, { ...f, transform: true }]) {
    assert.throws(() => parseAutomationFilter(bad));
  }
  const config = (trigger: string, value: unknown) => JSON.stringify({ version: 1, automations: [{ id: "filter-test", name: "Filter", trigger, instructions: "Do work", filter: value }] });
  assert.equal(parseAutomationConfig(config("webhook", f)).ok, true);
  assert.equal(parseAutomationConfig(config("manual", f)).ok, false);
  assert.equal(parseAutomationConfig(config("webhook", { ...f, cwd: "." })).ok, false);
  assert.throws(() => decodeAutomationTemplate('bivy-automation-v1\n' + JSON.stringify({ instructions: "x", credentialLabels: {}, filter: {} })));
});

test("gate records accept/skip and never accepts missing/malformed context", async () => {
  const reports: Record<string, unknown>[] = [];
  const report = async (p: Record<string, unknown>) => { reports.push(p); };
  const signal = new AbortController().signal;
  for (const decision of ["accept", "skip"]) {
    assert.equal(await passWebhookFilter(filter(`console.log('${JSON.stringify({ decision, reason: "test" })}')`), { id: "run-1", eventContext: '{"a":1}' }, report, signal), decision === "accept");
  }
  assert.equal((reports[1].checks as Array<{ status: string }>)[0].status, "skipped");
  assert.match(JSON.stringify(reports), /Webhook filter skipped delivery: test/);
  for (const eventContext of [undefined, "not JSON", "null", '"text"']) {
    await assert.rejects(passWebhookFilter(filter(""), { id: "run-1", eventContext }, report, signal), AutomationFilterError);
  }
});

test("test-filter CLI executes the configured filter against a raw JSON fixture", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-filter-cli-"));
  try {
    const config = path.join(dir, "automations.json");
    const event = path.join(dir, "event.json");
    fs.writeFileSync(config, JSON.stringify({ version: 1, automations: [{ id: "test-hook", name: "Test hook", trigger: "webhook", instructions: "Do work", filter: filter(`console.log('{"decision":"skip","reason":"test fixture"}')`) }] }));
    fs.writeFileSync(event, '{"draft":true}');
    const run = spawnSync(process.execPath, ["--import", "tsx", "src/automation-cli.ts", "test-filter", "--id", "test-hook", config, "--event", event], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { decision: "skip", reason: "test fixture" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
