// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ProcessRuntime } from "../src/runtime/process.js";
import { RemoteRuntime, connectSocketTransport } from "../src/runtime/remote.js";
import type { RuntimeEvent, RuntimeMessage, RuntimeSession } from "../src/runtime/types.js";

/**
 * End-to-end: a real agent service in a SEPARATE process hosts the real
 * ProcessRuntime (an echo agent — `cat` — reading the prompt from stdin), and
 * the daemon-side RemoteRuntime drives it over a loopback Unix socket. We assert
 * the daemon-observed event stream is identical to running the SAME runtime
 * in-process — the core Stage 1 guarantee.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const servicePath = path.join(repoRoot, "src", "runtime", "agent-service-bin.ts");

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collect the event stream of one prompt turn, resolving on agent_end. */
function drainTurn(session: RuntimeSession): { done: Promise<void>; events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "agent_end") resolve();
  });
  return { done, events };
}

/** Roles+content only — drop the per-run user timestamp so the two paths compare. */
function normalize(messages: RuntimeMessage[]): Array<{ role: unknown; content: unknown }> {
  return messages.map((m) => ({ role: (m as Record<string, unknown>).role, content: (m as Record<string, unknown>).content }));
}

async function connectWithRetry(addr: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  const opts: net.NetConnectOpts = { path: addr.replace(/^unix:/, "") };
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(opts);
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw new Error(`agent service not reachable at ${addr}: ${String(error)}`);
      await delay(150);
    }
  }
}

test("remote runtime streams a turn identically to the in-process runtime", async (t) => {
  const sockPath = path.join(os.tmpdir(), `bivy-agent-${process.pid}-${Math.floor(Math.random() * 1e6)}.sock`);
  const addr = `unix:${sockPath}`;

  // --- 1. In-process baseline: the real ProcessRuntime, driven directly. ------
  const local = new ProcessRuntime({ id: "generic-cli", command: "cat", promptMode: "stdin" });
  const localOpen = await local.createSession({ workspace: repoRoot });
  const localTurn = drainTurn(localOpen.session);
  await localOpen.session.prompt("hello from bivy");
  await localTurn.done;

  // --- 2. Spawn the agent service in its OWN process over a loopback socket. --
  const service: ChildProcess = spawn(tsxBin, [servicePath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BIVY_AGENT_SERVICE_LISTEN: addr,
      BIVY_RUNTIME: "generic-cli",
      BIVY_AGENT_COMMAND: "cat",
      BIVY_AGENT_PROMPT_MODE: "stdin",
      BIVY_AGENT_ID: "generic-cli",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(async () => {
    service.kill("SIGTERM");
    await delay(100);
    if (!service.killed) service.kill("SIGKILL");
  });
  service.on("error", (error) => assert.fail(`failed to spawn agent service: ${String(error)}`));
  await connectWithRetry(addr);

  // --- 3. Daemon side: RemoteRuntime over the socket. -------------------------
  const remote = new RemoteRuntime({
    targetRuntime: "generic-cli",
    displayName: "Generic CLI Agent",
    capabilities: { toolInterception: false, modelSelection: false, packages: false, resume: false, fork: false },
    connect: () => connectSocketTransport(addr),
  });
  const remoteOpen = await remote.createSession({ workspace: repoRoot });
  const remoteTurn = drainTurn(remoteOpen.session);
  await remoteOpen.session.prompt("hello from bivy");
  await remoteTurn.done;

  // --- 4. The daemon-observed streams must match. -----------------------------
  const localTypes = localTurn.events.map((e) => e.type);
  const remoteTypes = remoteTurn.events.map((e) => e.type);
  assert.deepEqual(remoteTypes, localTypes, "remote event type sequence matches in-process");
  assert.deepEqual(localTypes, ["agent_start", "turn_start", "message_start", "message_update", "message_end", "turn_end", "agent_end"]);

  // Final transcript matches (roles+content), and the echo actually round-tripped.
  assert.deepEqual(normalize(remoteOpen.session.getMessages()), normalize(localOpen.session.getMessages()));
  const remoteAssistant = remoteOpen.session.getMessages().find((m) => (m as Record<string, unknown>).role === "assistant");
  assert.match(String((remoteAssistant as Record<string, unknown>).content), /hello from bivy/);

  // The agent_end payload (exit code) is forwarded verbatim.
  const remoteEnd = remoteTurn.events.find((e) => e.type === "agent_end");
  assert.equal((remoteEnd as Record<string, unknown>).code, 0);

  localOpen.session.dispose();
  remoteOpen.session.dispose();
});
