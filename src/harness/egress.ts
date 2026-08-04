// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — egress-proxy singleton.
//
// A tiny shared holder so the daemon (server.ts) can start one EgressProxy at
// boot and the runtime layer (process.ts) can inject its env into every agent
// subprocess — without process.ts importing the server. Opt-in via the
// BIVY_EGRESS_PROXY env var, so routing all agent traffic through the broker is
// an explicit choice (it adds a hop and logs destinations).

import { EgressProxy, denyAllDecider, type NetDecider, type NetEvent } from "./net-proxy.js";
import type { SandboxTier } from "./sandbox.js";

let proxy: EgressProxy | undefined;

// Per-session egress proxies, keyed by session id. This is the plan's
// "per-workflow proxy/decider, never the singleton": a session that needs its own
// network policy (e.g. a read-only sandbox that must actually block egress, or a
// workflow with an allowlist) gets its OWN EgressProxy with its OWN decider,
// injected into just that session's subprocess — the node-global `proxy` above and
// every other session are untouched. Empty by default, so nothing here changes the
// default path.
const sessionProxies = new Map<string, EgressProxy>();

/** Start the egress proxy if BIVY_EGRESS_PROXY is set. Idempotent. */
export async function startEgressProxyIfEnabled(onEvent?: (event: NetEvent) => void): Promise<EgressProxy | undefined> {
  if (proxy) return proxy;
  if (!process.env.BIVY_EGRESS_PROXY) return undefined;
  proxy = await EgressProxy.start({ onEvent });
  return proxy;
}

/** Proxy env to merge into an agent subprocess, or {} when disabled. */
export function egressEnv(): Record<string, string> {
  return proxy ? proxy.env() : {};
}

export async function stopEgressProxy(): Promise<void> {
  if (!proxy) return;
  await proxy.stop();
  proxy = undefined;
}

// --- Per-session egress (the per-workflow proxy/decider) --------------------

/**
 * Start a per-session egress proxy governed by `decide`, keyed to `sessionId`.
 * Its `env()` is what `sessionEgressEnv(sessionId)` returns, so the runtime
 * injects it into that session's subprocess *instead of* the node-global proxy.
 * Idempotent per session. Best-effort — a listen failure leaves the session on the
 * default path rather than blocking it.
 */
export async function startSessionEgress(sessionId: string, decide: NetDecider, onEvent?: (event: NetEvent) => void): Promise<void> {
  if (sessionProxies.has(sessionId)) return;
  try {
    const p = await EgressProxy.start({ decide, onEvent });
    // A concurrent start for the same id won the race — keep the first, stop this.
    if (sessionProxies.has(sessionId)) { await p.stop(); return; }
    sessionProxies.set(sessionId, p);
  } catch {
    // Leave the session on the default egress path (global proxy or none).
  }
}

/** The per-session proxy env to inject for `sessionId`, or undefined when it has
 *  none (the caller then falls back to the node-global `egressEnv()`). */
export function sessionEgressEnv(sessionId: string): Record<string, string> | undefined {
  return sessionProxies.get(sessionId)?.env();
}

/** Tear down a session's own egress proxy (call on session close). Idempotent. */
export async function stopSessionEgress(sessionId: string): Promise<void> {
  const p = sessionProxies.get(sessionId);
  if (!p) return;
  sessionProxies.delete(sessionId);
  await p.stop().catch(() => {});
}

/**
 * Apply the sandbox tier's network policy to a session as a per-session proxy.
 * `read-only` means "no writes, no network" (see sandbox.ts), but only agents with
 * a native sandbox enforce the network half — a CLI agent without one (opencode,
 * aider, goose) would still reach the internet. When enforcement is opted in
 * (`BIVY_SANDBOX_NET`), a read-only session gets a deny-all egress proxy so the
 * contract holds for every agent. Other tiers (workspace-write, danger-full-access)
 * allow network and get no per-session proxy. No-op unless opted in, so the default
 * path is unchanged. Node-local traffic (the daemon's MCP/API) is exempt via the
 * proxy env's NO_PROXY, so read-only sessions keep working against localhost.
 */
export async function applySessionSandboxEgress(sessionId: string, tier: SandboxTier, onEvent?: (event: NetEvent) => void): Promise<void> {
  if (!process.env.BIVY_SANDBOX_NET) return;
  if (tier !== "read-only") return;
  await startSessionEgress(sessionId, denyAllDecider(), onEvent);
}
