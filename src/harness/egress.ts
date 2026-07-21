// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — egress-proxy singleton.
//
// A tiny shared holder so the daemon (server.ts) can start one EgressProxy at
// boot and the runtime layer (process.ts) can inject its env into every agent
// subprocess — without process.ts importing the server. Opt-in via the
// BIVY_EGRESS_PROXY env var, so routing all agent traffic through the broker is
// an explicit choice (it adds a hop and logs destinations).

import { EgressProxy, type NetEvent } from "./net-proxy.js";

let proxy: EgressProxy | undefined;

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
