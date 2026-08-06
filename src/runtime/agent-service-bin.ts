// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Agent service entry point — runs the real agent runtimes in a process
 * SEPARATE from the node daemon and exposes them over the RPC protocol
 * (src/runtime/rpc-protocol.ts). Launch it beside a daemon and point the daemon
 * at it with BIVY_REMOTE_RUNTIME=1 + BIVY_REMOTE_RUNTIME_ADDR (see
 * docs/agent-runtime-rpc.md).
 *
 *   BIVY_AGENT_SERVICE_LISTEN            where to listen: "unix:/path.sock" | "PORT" | "host:PORT"
 *   BIVY_DATA_DIR                        data dir (defaults to <cwd>/.bivy), same as the daemon
 *   BIVY_REMOTE_RUNTIME_DETACH_REAP_MS   optional: reap a detached, idle session after this many ms (off by default)
 *
 * Dev:  tsx src/runtime/agent-service-bin.ts
 * Prod: node dist/runtime/agent-service-bin.js
 *
 * The service must have the same agent binaries on PATH and credential access
 * the in-process daemon would (the Claude SDK execs the `claude` CLI internally),
 * because the child now runs HERE, not in the daemon.
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentService, type ServiceConnection } from "./agent-service.js";
import { encodeFrame, FrameDecoder, type ClientMessage } from "./rpc-protocol.js";
import { parseRemoteAddress } from "./remote.js";
import { makeRuntime, type AgentRuntime } from "./index.js";
import { defaultDataDir } from "../data-dir.js";
import type { SandboxTier } from "../harness/sandbox.js";

/** Adapt a raw socket to the transport-agnostic ServiceConnection. */
export function socketConnection(socket: net.Socket): ServiceConnection {
  const decoder = new FrameDecoder();
  let onMessage: ((message: ClientMessage) => void) | undefined;
  let onClose: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    let messages: ClientMessage[];
    try {
      messages = decoder.push(chunk) as ClientMessage[];
    } catch {
      socket.destroy();
      return;
    }
    if (onMessage) for (const message of messages) onMessage(message);
  });
  socket.on("error", () => {
    // A 'close' event always follows; teardown happens there.
  });
  socket.on("close", () => onClose?.());
  return {
    send(message) {
      try {
        socket.write(encodeFrame(message));
      } catch {
        // peer went away mid-write; 'close' will reap
      }
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      socket.destroy();
    },
  };
}

export interface ServiceServerOptions {
  service: AgentService;
  /** Address string: "unix:/path.sock" | "PORT" | "host:PORT". */
  listen: string;
}

/** Start a socket server that hands each connection to the AgentService. */
export function startAgentServiceServer(options: ServiceServerOptions): Promise<net.Server> {
  const server = net.createServer((socket) => options.service.accept(socketConnection(socket)));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(parseRemoteAddress(options.listen), () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

/** Build the default runtime provider backed by the real runtime registry. */
export function defaultRuntimeProvider(): (runtimeId: string, sandbox?: string) => AgentRuntime {
  const appDir = defaultDataDir();
  const piDir = path.join(appDir, "pi");
  const sessionsDir = path.join(piDir, "sessions");
  // The shared, agent-neutral credential vault (not inside any agent's dir).
  const credsDir = path.join(appDir, "credentials");
  // Build the runtime the daemon asked for directly via makeRuntime — NOT
  // through RuntimeHost.resolveRuntimeId, whose picker/availability gate is the
  // daemon's UI concern. The daemon already chose the id; the service just hosts
  // it (makeRuntime still throws if the agent binary/SDK is missing here).
  // Node-hosted tools (Bivy integrations / MCP) reach the runtime here via the
  // per-session ToolProvider the daemon supplies over RPC (agent-agnostic), so
  // the service needs no runtime-specific tool wiring of its own.
  const factory = { credsDir, piDir, sessionsDir };
  const cache = new Map<string, AgentRuntime>();
  return (runtimeId, sandbox) => {
    const key = sandbox ? `${runtimeId}::sandbox=${sandbox}` : runtimeId;
    let rt = cache.get(key);
    if (!rt) {
      rt = makeRuntime({ ...factory, runtime: runtimeId, sandbox: sandbox as SandboxTier | undefined });
      cache.set(key, rt);
    }
    return rt;
  };
}

async function main(): Promise<void> {
  const listen = process.env.BIVY_AGENT_SERVICE_LISTEN?.trim();
  if (!listen) {
    console.error("[agent-service] BIVY_AGENT_SERVICE_LISTEN is required (e.g. unix:/tmp/bivy-agent.sock or 4711)");
    process.exit(2);
  }
  // Idle-reaper for DETACHED sessions (Stage 3). Off by default; set
  // BIVY_REMOTE_RUNTIME_DETACH_REAP_MS to bound how long a session the daemon
  // evicted/lost persists here with no bound connection.
  const detachReapMs = Number(process.env.BIVY_REMOTE_RUNTIME_DETACH_REAP_MS) || 0;
  const service = new AgentService({ runtimeProvider: defaultRuntimeProvider(), log: (message) => console.error(`[agent-service] ${message}`), detachReapMs });
  if (detachReapMs > 0) console.error(`[agent-service] detached-session idle reaper: ${detachReapMs}ms`);
  const server = await startAgentServiceServer({ service, listen });
  console.error(`[agent-service] listening on ${listen} (pid ${process.pid}, host ${os.hostname()})`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[agent-service] ${signal} — reaping ${service.sessionCount} session(s)`);
    service.disposeAll(); // reap every child so the service leaves no orphans
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Crash net: this service process hosts detached agent sessions, so a stray
  // unhandled rejection/exception must not tear all of them down. Log and keep
  // running; a real supervisor restart remains the fallback.
  process.on("unhandledRejection", (reason) => {
    console.error("[bivy agent-service] unhandledRejection (kept running):", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[bivy agent-service] uncaughtException (kept running):", error);
  });
}

// Run only when executed directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
