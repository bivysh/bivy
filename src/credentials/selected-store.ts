// SPDX-License-Identifier: AGPL-3.0-only
import type { BivyCredentialStore, StoredCredentialInfo } from "./store.js";
import type { CredentialContext, StoredCredential } from "./types.js";
import { defaultPresetsPath, loadPresets } from "./presets.js";
import { selectCredential } from "./selection.js";

/** A provider-addressed view of the vault for consumers without labeled accounts.
 * Resolve on every operation; never copy a work credential into the default slot.
 * Refresh writes stay attached to the selected record's label and metadata.
 */
export function selectedCredentialStore(store: BivyCredentialStore, credsDir: string, context?: CredentialContext) {
  const select = async (provider: string) => selectCredential(provider, await store.listRecords(), loadPresets(defaultPresetsPath(credsDir)), context)?.record;
  return {
    async read(provider: string): Promise<StoredCredential | undefined> {
      const record = await select(provider);
      if (record?.source.kind !== "stored") return undefined;
      const { updatedAt: _updatedAt, ...credential } = record.source.cred;
      return credential as StoredCredential;
    },
    async list(): Promise<readonly StoredCredentialInfo[]> {
      const records = await store.listRecords();
      const presets = loadPresets(defaultPresetsPath(credsDir));
      return [...new Set(records.map((r) => r.provider))].flatMap((providerId) => {
        const record = selectCredential(providerId, records, presets, context)?.record;
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
