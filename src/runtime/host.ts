// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { listRuntimes, makeRuntime, type AgentRuntime, type RuntimeFactoryOptions, type RuntimeInfo } from "./index.js";
import { RemoteRuntime, connectSocketTransport } from "./remote.js";
import type { SandboxTier } from "../harness/sandbox.js";
import type { DiscoveredNativeSession, OpenSessionOptions, OpenSessionResult, RuntimeCapabilities, RuntimeMessage, SessionSummary } from "./types.js";

export type EnforcementLevel = "strong" | "boundary" | "observe_only";

/**
 * Remote-runtime selection (Stage 1 of docs/agent-node-decoupling.md). When
 * BIVY_REMOTE_RUNTIME names a runtime (or "1"/"all") AND BIVY_REMOTE_RUNTIME_ADDR
 * points at an agent service, RuntimeHost.get() returns a RemoteRuntime for that
 * id instead of spawning it in-process. Absent/"0"/no address → the flag is off
 * and the in-process path is byte-identical to today (the default).
 */
interface RemoteRuntimeSelection {
  addr: string;
  enabled: (runtimeId: string) => boolean;
}

function remoteRuntimeSelection(): RemoteRuntimeSelection | null {
  const flag = process.env.BIVY_REMOTE_RUNTIME?.trim();
  if (!flag || flag === "0" || flag.toLowerCase() === "false") return null;
  const addr = process.env.BIVY_REMOTE_RUNTIME_ADDR?.trim();
  if (!addr) return null; // enabled but nowhere to connect — stay in-process
  const all = ["1", "true", "all", "*"].includes(flag.toLowerCase());
  const ids = all ? null : new Set(flag.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return { addr, enabled: (id) => all || Boolean(ids?.has(id)) };
}

/**
 * Whether the remote-runtime path is active at all (flag set AND an address to
 * connect to). Stage 3 gates startup adoption and the control-plane location
 * registry on this so those hooks are inert — and the daemon byte-identical —
 * when the flag is off (docs/agent-node-decoupling.md).
 */
export function remoteRuntimeEnabled(): boolean {
  return remoteRuntimeSelection() !== null;
}

/** Fill a RuntimeInfo's partial capabilities into a full, default-false surface. */
function fullCapabilities(partial: Partial<RuntimeCapabilities>): RuntimeCapabilities {
  return { toolInterception: false, modelSelection: false, packages: false, resume: false, fork: false, ...partial };
}

export interface RuntimeSummary {
  id: string;
  displayName: string;
  capabilities: RuntimeCapabilities;
  enforcementLevel: EnforcementLevel;
}

export function enforcementLevelFor(capabilities: Pick<RuntimeCapabilities, "toolInterception">, runtimeId?: string): EnforcementLevel {
  if (capabilities.toolInterception) return "strong";
  if (runtimeId === "generic-cli") return "boundary";
  return "observe_only";
}

/**
 * Small runtime host seam above concrete adapters. The node should talk to this
 * for registry lookup, adapter caching, session create/open/list, and capability
 * reporting instead of scattering runtime glue through server.ts.
 */
export class RuntimeHost {
  private readonly cache = new Map<string, AgentRuntime>();

  constructor(private readonly options: RuntimeFactoryOptions) {}

  list(currentId?: string): (RuntimeInfo & { current: boolean })[] {
    return listRuntimes(currentId);
  }

  resolveRuntimeId(requested: string | undefined, fallback: string): string {
    const wantId = (requested || fallback).toLowerCase();
    const info = this.list().find((candidate) => candidate.id === wantId);
    if (!info) throw new Error(`Unknown agent: ${wantId}`);
    if (info.status !== "available") throw new Error(`${info.displayName} is not available on this node yet.`);
    return wantId;
  }

  get(requested: string | undefined, fallback: string, sandbox?: SandboxTier): AgentRuntime {
    // Remote path (opt-in, reversible): return a RemoteRuntime that drives the
    // runtime in a separate agent service. Checked BEFORE resolveRuntimeId so a
    // runtime the daemon can't run locally (e.g. the Claude SDK isn't installed
    // here) is still offloadable — remote availability is the service's business.
    const remote = remoteRuntimeSelection();
    const wantId = (requested || fallback).toLowerCase();
    if (remote && remote.enabled(wantId)) return this.getRemote(wantId, remote.addr, sandbox);

    const id = this.resolveRuntimeId(requested, fallback);
    // A per-session sandbox override bakes into the runtime's launch flags, so it
    // must not share the cached instance built for the node default. Key such
    // runtimes by tier; runtimes without an override keep the plain-id entry.
    const key = sandbox ? `${id}::sandbox=${sandbox}` : id;
    let rt = this.cache.get(key);
    if (!rt) {
      rt = makeRuntime({ ...this.options, runtime: id, sandbox });
      this.cache.set(key, rt);
      if (!sandbox && rt.id !== id) this.cache.set(rt.id, rt);
    }
    return rt;
  }

  /**
   * Per-session remote routing (Stage 3, docs/agent-node-decoupling.md): build (or
   * reuse) a RemoteRuntime pointed at a SPECIFIC agent-service address, rather than
   * the process-wide BIVY_REMOTE_RUNTIME_ADDR. An adopted session may live on a
   * different service than the node default, so re-attach must target the address
   * recorded for that session. Caching is keyed by address, so distinct services
   * get distinct runtime facades.
   */
  getRemoteAt(id: string, addr: string, sandbox?: SandboxTier): AgentRuntime {
    return this.getRemote(id, addr, sandbox);
  }

  /** Build (and cache) a RemoteRuntime facade for `id`, addressed at `addr`. */
  private getRemote(id: string, addr: string, sandbox?: SandboxTier): AgentRuntime {
    const key = `remote::${addr}::${id}${sandbox ? `::sandbox=${sandbox}` : ""}`;
    let rt = this.cache.get(key);
    if (!rt) {
      // Passing `id` as currentId includes it even if it's hidden from the picker,
      // so the capability/displayName lookup works for any known runtime.
      const info = this.list(id).find((candidate) => candidate.id === id);
      if (!info) throw new Error(`Unknown agent: ${id}`);
      rt = new RemoteRuntime({
        targetRuntime: id,
        displayName: info.displayName,
        capabilities: fullCapabilities(info.capabilities),
        sandbox,
        agentServiceAddress: addr,
        connect: () => connectSocketTransport(addr),
      });
      this.cache.set(key, rt);
    }
    return rt;
  }

  summary(runtime: AgentRuntime): RuntimeSummary {
    return {
      id: runtime.id,
      displayName: runtime.displayName,
      capabilities: runtime.capabilities,
      enforcementLevel: enforcementLevelFor(runtime.capabilities, runtime.id),
    };
  }

  async createSession(runtime: AgentRuntime, options: OpenSessionOptions): Promise<OpenSessionResult> {
    return runtime.createSession(options);
  }

  async openSession(runtime: AgentRuntime, options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    return runtime.openSession(options);
  }

  async listSessions(runtime: AgentRuntime): Promise<SessionSummary[]> {
    return runtime.listSessions();
  }

  /** Ask a runtime to forget a session from its own store (see
   *  AgentRuntime.deleteSession). No-ops to `false` for runtimes that keep no
   *  store of their own. */
  async deleteSession(runtime: AgentRuntime, sessionId: string, sessionFile?: string): Promise<boolean> {
    return (await runtime.deleteSession?.(sessionId, sessionFile)) ?? false;
  }

  /** Fast, build-free transcript read for opening a session (see AgentRuntime.readMessages). */
  readMessages(runtime: AgentRuntime, sessionFile: string): RuntimeMessage[] | undefined {
    return runtime.readMessages?.(sessionFile);
  }

  /** Enumerate a runtime's own provider-native sessions this node didn't start
   *  (see AgentRuntime.discoverNativeSessions, issue #156). Empty for a runtime
   *  that doesn't support discovery, or on any adapter-level failure. */
  async discoverNativeSessions(runtime: AgentRuntime): Promise<DiscoveredNativeSession[]> {
    try {
      return (await runtime.discoverNativeSessions?.()) ?? [];
    } catch {
      return [];
    }
  }
}
