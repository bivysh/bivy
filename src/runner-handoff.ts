// SPDX-License-Identifier: AGPL-3.0-only
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
  const instructions = deps.openSealed(item.body!.slice(sealedPrefix(deps.nodeId).length));
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
