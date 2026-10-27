// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Handing queued work to a runner. Work whose instructions are sealed to this
 * machine (an automation's template) can only be opened here, so a runner,
 * which has its own key, can't read it. When the deployment runs runners, this
 * machine asks for one, pairs with it once it is online, re-seals the
 * instructions under the runner's key and moves the item to the runner's label.
 * The control plane only ever relays ciphertext. If any step fails, the item
 * stays here and runs in line as before.
 */

export interface HandOffItem {
  id: string;
  body?: string;
  targetKind?: string;
}

export interface HandOffDeps {
  /** This machine's node id: the key the item must be sealed to. */
  nodeId: string;
  /** POST to the control plane as this node; throws on a refusal. */
  post(path: string, body: unknown): Promise<Record<string, unknown>>;
  /** The runner's room key, from a sealed pairing with it; throws while it is offline. */
  roomKeyOf(nodeId: string): Promise<Buffer>;
  openSealed(payload: string): string;
  seal(key: Buffer, plaintext: string): string;
  /** Runs before the runner is asked for: e.g. freshen the sign-ins it will use.
   *  A failure is logged and the handoff goes ahead. */
  prepare?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a runner to come online. */
  waitMs?: number;
  retryMs?: number;
  log?: (message: string) => void;
}

const sealedPrefix = (nodeId: string) => `bivy-room-v1:${nodeId}:`;

/** Work this machine can hand off: sealed to it, and not a continuation of a
 * session that lives here. */
export function handOffApplies(nodeId: string, item: HandOffItem): boolean {
  return Boolean(item.body?.startsWith(sealedPrefix(nodeId))) && item.targetKind !== "existing_session";
}

/** True when the item now waits on a runner; false when it should run here. */
export async function handOffToRunner(deps: HandOffDeps, item: HandOffItem): Promise<boolean> {
  const log = deps.log ?? ((message: string) => console.log(`[runner-handoff] ${message}`));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!handOffApplies(deps.nodeId, item)) return false;
  await deps.prepare?.().catch((error) => log(`preparing sign-ins for a runner failed: ${error instanceof Error ? error.message : String(error)}`));
  let runner: string;
  try {
    const launched = await deps.post("/node/runners", { itemId: item.id });
    if (typeof launched.nodeId !== "string" || !launched.nodeId) return false;
    runner = launched.nodeId;
  } catch (error) {
    log(`${item.id} runs here: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const deadline = Date.now() + (deps.waitMs ?? 180_000);
  let key: Buffer | undefined;
  while (!key) {
    try {
      key = await deps.roomKeyOf(runner);
    } catch (error) {
      if (Date.now() >= deadline) {
        log(`${item.id} runs here: runner ${runner} never came online (${error instanceof Error ? error.message : String(error)})`);
        return false;
      }
      await sleep(deps.retryMs ?? 5_000);
    }
  }
  let instructions: string;
  try {
    instructions = deps.openSealed(item.body!.slice(sealedPrefix(deps.nodeId).length));
  } catch {
    // Sealed with a key this machine no longer has: re-saving the automation
    // seals it again. The runner, given no work, ends itself.
    log(`${item.id} can't be handed off: this machine can't open its instructions`);
    return false;
  }
  try {
    await deps.post(`/node/work/${encodeURIComponent(item.id)}/handoff`, {
      nodeId: runner,
      body: `${sealedPrefix(runner)}${deps.seal(key, instructions)}`,
    });
  } catch (error) {
    log(`${item.id} runs here: handoff refused (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
  log(`${item.id} handed to runner ${runner}`);
  return true;
}

export interface FreshenDeps {
  /** The account-synced subscription sign-ins: provider, label, access-token expiry (epoch ms). */
  signIns(): Promise<Array<{ provider: string; label: string; expires: number }>>;
  /** Refresh one if it expires within `withinMs`; true when it was refreshed. */
  refresh(provider: string, label: string, withinMs: number): Promise<boolean>;
  /** Publish the vault to the account's other machines. */
  publish(): Promise<void>;
  now?: () => number;
}

/**
 * Make the sign-ins a runner will use last as long as the runner can. A runner
 * never refreshes (a second machine spending a rotating refresh token signs the
 * owner out), so before handing work to one, the machine that owns the logins
 * refreshes any that would expire within the runner's lifetime and publishes
 * the vault the runner reads when it starts. Returns the providers refreshed.
 */
export async function freshenSignInsForRunner(deps: FreshenDeps, withinMs: number): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const refreshed: string[] = [];
  for (const signIn of await deps.signIns()) {
    if (signIn.expires > now + withinMs) continue;
    if (await deps.refresh(signIn.provider, signIn.label, withinMs)) refreshed.push(signIn.provider);
  }
  if (refreshed.length) await deps.publish();
  return refreshed;
}
