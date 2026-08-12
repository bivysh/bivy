// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Server-side ephemeral teardown: lets a disposable machine's OWN daemon end
 * itself once it goes idle, so teardown no longer depends on the launching
 * device staying online (the founding "requires this device to stay online"
 * limitation). Enabled only when the bootstrap set `BIVY_EPHEMERAL=1` — a
 * destroy-lane provider (Fly / Hetzner / EC2); suspend-to-zero providers
 * (Sprites / E2B) are kept and never given the env. See
 * `bivyBootstrapExports` in packages/core/src/ephemeral.ts and
 * docs/ephemeral-sessions.md.
 *
 * The decision (`shouldSelfTeardown`) is a pure function so it can be unit-tested
 * exhaustively; the side effects (`performSelfTeardown`) are a thin, injectable
 * shell around `process.exit` / `shutdown` / a control-plane signal.
 */

export interface EphemeralTeardownConfig {
  /** True when this daemon runs on a disposable, self-terminating machine. */
  enabled: boolean;
  /** Provider id (`fly` / `hetzner` / `aws`) — drives the teardown action. */
  provider: string;
  /** The machine's TTL in minutes (bookkeeping / logging only; the TTL
   *  self-shutdown is armed independently in the bootstrap). */
  ttlMin: number;
  /** The device's "Destroy when the agent finishes" intent, moved server-side:
   *  use the short finish grace rather than the long idle window. */
  onFinish: boolean;
  /** Grace after the machine goes quiet before a finish-teardown fires. */
  finishGraceMs: number;
  /** Idle window before an idle-teardown fires (a shared queue worker only exits
   *  once its queue AND sessions have been quiet this long). */
  idleGraceMs: number;
}

/** Parse the daemon's ephemeral-teardown config from the process env. */
export function readEphemeralTeardownConfig(env: NodeJS.ProcessEnv = process.env): EphemeralTeardownConfig {
  return {
    enabled: env.BIVY_EPHEMERAL === "1",
    provider: String(env.BIVY_EPHEMERAL_PROVIDER || "").toLowerCase(),
    ttlMin: Number(env.BIVY_EPHEMERAL_TTL_MIN) || 60,
    onFinish: env.BIVY_TEARDOWN_ON_FINISH === "1",
    finishGraceMs: Number(env.BIVY_TEARDOWN_FINISH_GRACE_MS) || 10_000,
    idleGraceMs: Number(env.BIVY_SESSION_IDLE_CLOSE_MS) || 30 * 60 * 1000,
  };
}

export interface TeardownState {
  /** The machine has been busy at least once — guards against tearing down a
   *  freshly-booted machine before its session/queue work has even started. */
  everBusy: boolean;
  /** Any session is currently running a turn. */
  anyWorking: boolean;
  /** Any session has a remote client attached (a device is watching live). */
  anyRemoteActive: boolean;
  /** In-flight hosted queue work items. */
  inFlightWork: number;
  /** How long the machine has been continuously quiet, in ms. */
  idleForMs: number;
}

/**
 * Pure decision: should this ephemeral machine tear itself down now? True only
 * when it has done work at least once and is now fully quiet — nothing running,
 * no device attached, no queue work in flight — for longer than the applicable
 * grace (short after an agent finishes, else the idle window).
 */
export function shouldSelfTeardown(cfg: EphemeralTeardownConfig, state: TeardownState): boolean {
  if (!cfg.enabled) return false;
  if (!state.everBusy) return false;
  if (state.anyWorking || state.anyRemoteActive || state.inFlightWork > 0) return false;
  const grace = cfg.onFinish ? cfg.finishGraceMs : cfg.idleGraceMs;
  return state.idleForMs >= grace;
}

/** Result of persisting the open sessions that would otherwise disappear with
 * the machine. A teardown is safe only when every non-empty session snapshot
 * reached durable storage. Empty sessions do not require a snapshot. */
export interface SnapshotFlushResult {
  required: number;
  persisted: number;
  failed: number;
}

export function snapshotsDurableForTeardown(result: SnapshotFlushResult): boolean {
  return result.failed === 0 && result.persisted === result.required;
}

export interface TeardownActionDeps {
  provider: string;
  /** Best-effort POST /node/settled so the control plane can reap providers that
   *  don't self-reap (hosted Hetzner) and update its bookkeeping. */
  signalSettled?: () => Promise<void>;
  /** Run `shutdown -h now` — EC2 self-terminates (InstanceInitiatedShutdownBehavior). */
  shutdown?: () => void;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
}

let torndown = false;
/** Reset the once-only latch — tests only. */
export function __resetTeardownLatch(): void {
  torndown = false;
}

/**
 * Execute the teardown. Signals the control plane, then stops the daemon:
 * - Fly: exiting the init process trips `auto_destroy` — the machine is reaped.
 * - EC2: `shutdown -h now` self-terminates the instance, then we exit.
 * - Hetzner: exiting takes the node offline; the control-plane reconciler issues
 *   the provider DELETE (it can't self-reap on OS shutdown). The /node/settled
 *   signal makes that prompt; the CP timer is the backstop.
 * Once-only: a racing idle sweep + agent_end can both call this safely.
 */
export async function performSelfTeardown(deps: TeardownActionDeps): Promise<void> {
  if (torndown) return;
  torndown = true;
  const log = deps.log ?? ((m: string) => console.log(`[ephemeral-teardown] ${m}`));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  log(`machine idle — self-teardown (provider=${deps.provider})`);
  try {
    await deps.signalSettled?.();
  } catch {
    /* best effort — the CP timer reconciler and TTL are the backstops */
  }
  if (deps.provider === "aws") {
    try {
      deps.shutdown?.();
    } catch {
      /* fall through to exit; the TTL shutdown still backstops */
    }
  }
  exit(0);
}
