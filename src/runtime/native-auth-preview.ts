// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createHash, randomUUID } from "node:crypto";
import type { NativeCredentialPreview, NativeCredentialImportResult } from "../../packages/core/src/protocol.js";
import { createCredentialVault } from "./credential-store.js";
import { discoverNativeAuth, nativeAuthSources, type NativeAuthAgent } from "./native-auth-import.js";
import { normalizeLabel } from "../credentials/records.js";

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bounded, expiring previews. No tokens or token hashes are sent to the browser.
 * Confirmation re-reads the source, refusing logins changed since the preview. */
export class NativeAuthPreviewService {
  private previews = new Map<string, { label: string; expires: number; fingerprints: Map<NativeAuthAgent, string> }>();
  constructor(private readonly credsDir: string) {}

  async preview(rawLabel: unknown): Promise<NativeCredentialPreview> {
    if (rawLabel !== undefined && (typeof rawLabel !== "string" || rawLabel.length > 100)) throw new Error("Invalid credential label.");
    const label = normalizeLabel(rawLabel as string | undefined);
    const vault = createCredentialVault(this.credsDir);
    const items: NativeCredentialPreview["items"] = [];
    const fingerprints = new Map<NativeAuthAgent, string>();
    for (const agent of Object.keys(nativeAuthSources) as NativeAuthAgent[]) {
      const found = discoverNativeAuth(agent);
      if (found.status !== "found") { items.push({ agent, status: found.status }); continue; }
      const conflict = Boolean(await vault.readRecord(found.provider, label));
      items.push({ agent, provider: found.provider, kind: found.credential.type, status: conflict ? "conflict" : "ready" });
      if (!conflict) fingerprints.set(agent, fingerprint(found));
    }
    for (const [id, entry] of this.previews) if (entry.expires < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value!);
    const previewId = randomUUID();
    this.previews.set(previewId, { label, expires: Date.now() + 5 * 60_000, fingerprints });
    return { previewId, label, items };
  }

  async import(previewId: unknown, agents: unknown, sync: unknown): Promise<NativeCredentialImportResult> {
    if (sync !== "node" && sync !== "account") throw new Error("Choose node or account availability.");
    const preview = typeof previewId === "string" ? this.previews.get(previewId) : undefined;
    if (!preview || preview.expires < Date.now()) throw new Error("Preview expired or belongs to another machine. Scan again.");
    if (!Array.isArray(agents) || !agents.length || agents.length > 3 || agents.some((agent) => !preview.fingerprints.has(agent))) throw new Error("Select logins from the preview.");
    this.previews.delete(previewId as string);
    const vault = createCredentialVault(this.credsDir);
    const items: NativeCredentialImportResult["items"] = [];
    for (const agent of new Set(agents as NativeAuthAgent[])) {
      const found = discoverNativeAuth(agent);
      if (found.status !== "found" || fingerprint(found) !== preview.fingerprints.get(agent)) {
        items.push({ agent, status: "changed" }); continue;
      }
      const inserted = await vault.putRecordIfAbsent({ provider: found.provider, label: preview.label,
        sync, origin: "agent-native", source: { kind: "stored", cred: found.credential } });
      items.push({ agent, status: inserted ? "imported" : "conflict" });
    }
    return { items };
  }
}
