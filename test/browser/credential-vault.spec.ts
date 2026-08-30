// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("settings exposes one credential vault rather than device and machine forms", async () => {
  const settings = await read("../../packages/web/src/components/Settings.tsx");
  expect(settings).toContain('<CredentialVault state={state} initialProvider={credentialProvider} />');
  expect(settings).not.toContain("AccountApiKeys");
  expect(settings).not.toContain("ProvidersPanel");
  expect(settings).not.toContain("PresetBar");
});

test("vault unifies saved providers, custom endpoints, assignment and unattended flows", async () => {
  const vault = await read("../../packages/web/src/components/CredentialVault.tsx");
  expect(vault).toContain("BIVY_PROVIDER_CATALOG");
  expect(vault).toContain("No providers yet");
  expect(vault).toContain("Local server or custom endpoint");
  expect(vault).toContain("Test endpoint & find models");
  expect(vault).toContain("Search providers");
  expect(vault).toContain("All my machines — end-to-end encrypted");
  expect(vault).toContain("Use for {projectId}");
  expect(vault).toContain("Assign for project or repository");
  expect(vault).toContain("Used by projects");
  expect(vault).toContain("Allow unattended runs");
  expect(vault).toContain("Machine availability");
});

test("browser-node convergence preserves an offline key rotation", async () => {
  const controller = await read("../../packages/web/src/store/coordinators/credentials-models-coordinator.ts");
  expect(controller).toContain("acceptedIncoming");
  expect(controller).toContain("remoteAt > localAt");
  expect(controller).toContain("deletedAt[recordId]");
  expect(controller).toContain("record.kind !== \"api_key\"");
  expect(controller).not.toContain('if (this.direct || this.store.getState().status !== "online")');
});

test("inline and first-run connect use the item-addressed credential path", async () => {
  const connect = await read("../../packages/web/src/components/ProviderConnect.tsx");
  expect(connect).toContain('controller.setCredential(keyProvider, "default"');
  expect(connect).toContain("controller.setEphemeralModelKey");
  expect(connect).not.toContain("controller.saveApiKey(keyProvider");
});
