// SPDX-License-Identifier: MIT
import type { BivyCredentialStore, StoredCredentialInfo } from "./store.js";
import type { CredentialContext, StoredCredential } from "./types.js";
import { defaultPresetsPath, loadPresets } from "./presets.js";
import { selectCredential } from "./selection.js";
import { CredentialSelectionError } from "./session.js";
import type { SecretResolver } from "./ports.js";

/** A provider-addressed view of the vault for consumers without labeled accounts.
 * Resolve on every operation; never copy a work credential into the default slot.
 * Refresh writes stay attached to the selected record's label and metadata.
 */
export function selectedCredentialStore(store: BivyCredentialStore, credsDir: string, context?: CredentialContext, secrets?: SecretResolver) {
  // A reference (op://, env://, cmd://) is an API key read at use time; without
  // a resolver it can't be used, so it is treated like no credential.
  const usable = (source: { kind: string }) => source.kind === "stored" || (source.kind === "reference" && Boolean(secrets));
  const selectRecord = (provider: string, records: Awaited<ReturnType<BivyCredentialStore["listRecords"]>>, presets: ReturnType<typeof loadPresets>) => {
    const record = selectCredential(provider, records, presets, context)?.record;
    const label = context?.credentialLabels?.[provider];
    if (label && (!record || !usable(record.source))) {
      throw new CredentialSelectionError(`Selected account “${label}” for ${provider} is unavailable on this machine`);
    }
    return record;
  };
  const select = async (provider: string) => selectRecord(provider, await store.listRecords(), loadPresets(defaultPresetsPath(credsDir)));
  return {
    async read(provider: string): Promise<StoredCredential | undefined> {
      const record = await select(provider);
      if (record?.source.kind === "reference" && secrets) {
        const key = (await secrets.resolve(record.source.ref).catch(() => undefined))?.trim();
        return key ? { type: "api_key", key } as StoredCredential : undefined;
      }
      if (record?.source.kind !== "stored") return undefined;
      const { updatedAt: _updatedAt, ...credential } = record.source.cred;
      return credential as StoredCredential;
    },
    async list(): Promise<readonly StoredCredentialInfo[]> {
      const records = await store.listRecords();
      const presets = loadPresets(defaultPresetsPath(credsDir));
      return [...new Set([...records.map((r) => r.provider), ...Object.keys(context?.credentialLabels ?? {})])].flatMap((providerId) => {
        const record = selectRecord(providerId, records, presets);
        if (record?.source.kind === "reference" && secrets) return [{ providerId, type: "api_key" as const }];
        if (record?.source.kind !== "stored") return [];
        const credential = record.source.cred;
        return [{ providerId, type: credential.type, ...(credential.type === "oauth" ? { expiresAt: credential.expires } : {}) }];
      });
    },
    async modify(provider: string, fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>): Promise<StoredCredential | undefined> {
      const record = await select(provider);
      if (!record) throw new Error(`No account selected for ${provider}`);
      return store.modifyRecord(provider, record.label, fn);
    },
  };
}
