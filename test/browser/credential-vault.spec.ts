// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("settings exposes one credential vault rather than device and machine forms", async () => {
  const settings = await read("../../packages/web/src/components/Settings.tsx");
  expect(settings).toContain('<CredentialVault state={state} />');
  expect(settings).not.toContain("AccountApiKeys");
  expect(settings).not.toContain("ProvidersPanel");
  expect(settings).not.toContain("PresetBar");
});

test("vault has saved-items, catalog add, detail, assignment and custody flows", async () => {
  const vault = await read("../../packages/web/src/components/CredentialVault.tsx");
  expect(vault).toContain("BIVY_PROVIDER_CATALOG");
  expect(vault).toContain("No credentials yet");
  expect(vault).toContain("Search providers");
  expect(vault).toContain("All my machines — end-to-end encrypted");
  expect(vault).toContain("Use for {state.draftRepo}");
  expect(vault).toContain("Allow unattended runs");
  expect(vault).toContain("Machine availability");
});

test("inline and first-run connect use the item-addressed credential path", async () => {
  const connect = await read("../../packages/web/src/components/ProviderConnect.tsx");
  expect(connect).toContain('controller.setCredential(keyProvider, "default"');
  expect(connect).toContain("controller.setEphemeralModelKey");
  expect(connect).not.toContain("controller.saveApiKey(keyProvider");
});
