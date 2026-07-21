// Issue #389: migrate the built-in CLI agents onto the generic resume primitive
// (the same data-driven `resume.template` mechanism Codex already used — see
// CLI_AGENT_SPECS in src/runtime/index.ts). This exercises the FULL dispatch
// (makeRuntime → ProcessRuntime.resumeArgs) with stub binaries standing in for
// real CLIs, so it runs in CI with no gemini/goose installed — plus the
// escape-hatch `generic-cli` runtime's BIVY_AGENT_RESUME_TEMPLATE env var.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRuntime } from "../src/runtime/index.js";
import { processRuntimeFromEnv } from "../src/runtime/process.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-resume-test-"));
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir);
const originalPath = process.env.PATH;
const originalTier = process.env.BIVY_SANDBOX;
process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

// A stub CLI: records its argv (space-joined) to $STUB_ARGS_FILE, then prints
// the given stdout lines and exits 0.
function writeStub(name: string, argsFile: string, stdoutLines: string[]) {
  const stub = path.join(binDir, name);
  fs.writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `printf '%s' "$*" > ${JSON.stringify(argsFile)}`,
      ...stdoutLines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`),
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function runToEnd(session: { subscribe: (l: (e: RuntimeEvent) => void) => () => void; prompt: (t: string) => Promise<void> }): Promise<RuntimeEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RuntimeEvent[] = [];
    const off = session.subscribe((e) => {
      events.push(e);
      if (e.type === "agent_end") {
        off();
        resolve(events);
      }
    });
    session.prompt("hello").catch((err) => {
      off();
      reject(err);
    });
    setTimeout(() => {
      off();
      reject(new Error("timed out waiting for agent_end"));
    }, 8000).unref();
  });
}

await check("gemini: resume template threads --approval-mode + -r <id>, tier-aware", async () => {
  process.env.BIVY_SANDBOX = "read-only";
  const argsFile = path.join(tmp, "gemini-args.txt");
  writeStub("gemini", argsFile, ['{"response":"resumed via gemini"}']);

  const runtime = makeRuntime({ runtime: "gemini", credsDir: tmp, piDir: tmp, sessionsDir: tmp });
  assert.equal(runtime.capabilities.resume, true, "gemini should advertise resume (built-in template)");

  const { session } = await runtime.openSession({ workspace: tmp, sessionFile: "sess-gem-1" });
  assert.equal(session.sessionFile, "sess-gem-1", "sessionFile round-trips the resume id");
  await runToEnd(session);

  const launched = fs.readFileSync(argsFile, "utf8");
  // {sandbox} expanded to the read-only tier's --approval-mode plan; {id} filled in.
  assert.ok(/--approval-mode plan/.test(launched), `expected --approval-mode plan, got: ${launched}`);
  assert.ok(/(^|\s)-r sess-gem-1(\s|$)/.test(launched), `expected '-r sess-gem-1', got: ${launched}`);
  assert.ok(/-o json/.test(launched), `expected structured -o json, got: ${launched}`);
});

await check("gemini: {sandbox} re-derives per tier (danger-full-access -> yolo)", async () => {
  process.env.BIVY_SANDBOX = "danger-full-access";
  const argsFile = path.join(tmp, "gemini-args-2.txt");
  writeStub("gemini", argsFile, ['{"response":"resumed via gemini"}']);

  const runtime = makeRuntime({ runtime: "gemini", credsDir: tmp, piDir: tmp, sessionsDir: tmp });
  const { session } = await runtime.openSession({ workspace: tmp, sessionFile: "sess-gem-2" });
  await runToEnd(session);

  const launched = fs.readFileSync(argsFile, "utf8");
  assert.ok(/--approval-mode yolo/.test(launched), `expected --approval-mode yolo, got: ${launched}`);
});

await check("goose: resume template threads --resume --session-id <id> (no sandbox flag)", async () => {
  delete process.env.BIVY_SANDBOX;
  const argsFile = path.join(tmp, "goose-args.txt");
  writeStub("goose", argsFile, [
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"resumed via goose"}]}}',
    '{"type":"complete"}',
  ]);

  const runtime = makeRuntime({ runtime: "goose", credsDir: tmp, piDir: tmp, sessionsDir: tmp });
  assert.equal(runtime.capabilities.resume, true, "goose should advertise resume (built-in template)");

  const { session } = await runtime.openSession({ workspace: tmp, sessionFile: "sess-goose-1" });
  await runToEnd(session);

  const launched = fs.readFileSync(argsFile, "utf8");
  assert.ok(/--resume/.test(launched), `expected --resume, got: ${launched}`);
  assert.ok(/--session-id sess-goose-1/.test(launched), `expected --session-id sess-goose-1, got: ${launched}`);
});

await check("aider/crush: no built-in resume template (documented upstream gap)", () => {
  writeStub("aider", path.join(tmp, "aider-args.txt"), [""]);
  writeStub("crush", path.join(tmp, "crush-args.txt"), [""]);
  const aider = makeRuntime({ runtime: "aider", credsDir: tmp, piDir: tmp, sessionsDir: tmp });
  const crush = makeRuntime({ runtime: "crush", credsDir: tmp, piDir: tmp, sessionsDir: tmp });
  assert.equal(aider.capabilities.resume, false, "aider has no native continue-by-id flag upstream");
  assert.equal(crush.capabilities.resume, false, "crush has no native continue-by-id flag upstream");
});

await check("generic-cli: BIVY_AGENT_RESUME_TEMPLATE opts the escape hatch into the same primitive", () => {
  const priorCommand = process.env.BIVY_AGENT_COMMAND;
  const priorTemplate = process.env.BIVY_AGENT_RESUME_TEMPLATE;
  try {
    process.env.BIVY_AGENT_COMMAND = "some-custom-agent";
    delete process.env.BIVY_AGENT_RESUME_TEMPLATE;
    const plain = processRuntimeFromEnv();
    assert.ok(plain, "should resolve options once BIVY_AGENT_COMMAND is set");
    assert.equal(plain!.resumeArgs, undefined, "no template configured -> resumeArgs absent");
    assert.equal(plain!.resumable, undefined, "no template configured -> resumable absent");

    process.env.BIVY_AGENT_RESUME_TEMPLATE = JSON.stringify(["--continue", "{id}"]);
    const resumable = processRuntimeFromEnv();
    assert.equal(resumable!.resumable, true, "a configured template should set resumable");
    assert.deepEqual(resumable!.resumeArgs?.("ref-123"), ["--continue", "ref-123"], "resumeArgs should fill the {id} placeholder");
  } finally {
    if (priorCommand === undefined) delete process.env.BIVY_AGENT_COMMAND;
    else process.env.BIVY_AGENT_COMMAND = priorCommand;
    if (priorTemplate === undefined) delete process.env.BIVY_AGENT_RESUME_TEMPLATE;
    else process.env.BIVY_AGENT_RESUME_TEMPLATE = priorTemplate;
  }
});

if (originalTier === undefined) delete process.env.BIVY_SANDBOX;
else process.env.BIVY_SANDBOX = originalTier;
process.env.PATH = originalPath;

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

if (failures > 0) {
  console.error(`\n${failures} cli-resume-template test(s) failed.`);
  process.exit(1);
}
console.log("\nAll cli-resume-template tests passed.");
