// SPDX-License-Identifier: AGPL-3.0-only
import type { BivyCredentialStore, StoredCredentialInfo } from "./store.js";
import type { CredentialContext, StoredCredential } from "./types.js";
import { defaultPresetsPath, loadPresets } from "./presets.js";
import { selectCredential } from "./selection.js";
import { CredentialSelectionError } from "./session.js";

/** A provider-addressed view of the vault for consumers without labeled accounts.
 * Resolve on every operation; never copy a work credential into the default slot.
 * Refresh writes stay attached to the selected record's label and metadata.
 */
export function selectedCredentialStore(store: BivyCredentialStore, credsDir: string, context?: CredentialContext) {
  const selectRecord = (provider: string, records: Awaited<ReturnType<BivyCredentialStore["listRecords"]>>, presets: ReturnType<typeof loadPresets>) => {
    const record = selectCredential(provider, records, presets, context)?.record;
    const label = context?.credentialLabels?.[provider];
    if (label && (!record || record.source.kind !== "stored")) {
      throw new CredentialSelectionError(`Selected account “${label}” for ${provider} is unavailable on this machine`);
    }
    return record;
  };
  const select = async (provider: string) => selectRecord(provider, await store.listRecords(), loadPresets(defaultPresetsPath(credsDir)));
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
      return [...new Set([...records.map((r) => r.provider), ...Object.keys(context?.credentialLabels ?? {})])].flatMap((providerId) => {
        const record = selectRecord(providerId, records, presets);
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
