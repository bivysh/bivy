// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { open, seal } from "./e2e.js";

/**
 * Automation instructions are stored as `bivy-room-v1:<node>:<ciphertext>`,
 * sealed under the node's room key. Revoking a device rotates that key, which
 * would leave every stored template unreadable to both the node and its paired
 * devices. This pass re-seals each template still under a retired key.
 */
export interface StoredTemplate {
  id: string;
  templateCiphertext: string;
}

export interface ResealResult {
  resealed: number;
  /** Sealed under a key this node no longer has; only re-entering the instructions recovers them. */
  unreadable: string[];
}

export async function resealAutomationTemplates(opts: {
  nodeId: string;
  current: Buffer;
  retired: Buffer[];
  templates: StoredTemplate[];
  save: (id: string, templateCiphertext: string) => Promise<void>;
}): Promise<ResealResult> {
  const prefix = `bivy-room-v1:${opts.nodeId}:`;
  const result: ResealResult = { resealed: 0, unreadable: [] };
  for (const template of opts.templates) {
    if (!template.templateCiphertext.startsWith(prefix)) continue;
    const payload = template.templateCiphertext.slice(prefix.length);
    if (tryOpen(opts.current, payload) !== undefined) continue;
    const plaintext = opts.retired.map((key) => tryOpen(key, payload)).find((text) => text !== undefined);
    if (plaintext === undefined) {
      result.unreadable.push(template.id);
      continue;
    }
    await opts.save(template.id, `${prefix}${seal(opts.current, plaintext)}`);
    result.resealed += 1;
  }
  return result;
}

function tryOpen(key: Buffer, payload: string): string | undefined {
  try { return open(key, payload); } catch { return undefined; }
}
