// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("PWA prefers a connected machine's loopback callback over localhost copy/paste", async () => {
  const connect = await read("../../packages/web/src/components/ProviderConnect.tsx");
  expect(connect).toContain("Open sign-in on ${machine}");
  expect(connect).toContain("The provider will return directly to Bivy on that machine");
  expect(connect).toContain("!canOpenOnNode || deviceFallback");
  expect(connect).toContain("Use this device instead");
});

test("device-code and clipboard fallback remain available", async () => {
  const connect = await read("../../packages/web/src/components/ProviderConnect.tsx");
  expect(connect).toContain("Continue on this device");
  expect(connect).toContain("oauth.deviceCode?.userCode");
  expect(connect).toContain("Paste redirect from clipboard");
});

test("relay and direct transports share the safe node-open command", async () => {
  const coordinator = await read("../../packages/web/src/store/coordinators/credentials-models-coordinator.ts");
  const direct = await read("../../packages/core/src/transport-direct.ts");
  const server = await read("../../src/server.ts");
  expect(coordinator).toContain('kind: "provider.oauth.open_on_node"');
  expect(direct).toContain('case "provider.oauth.open_on_node"');
  expect(server).toContain('"provider.oauth.open_on_node"(msg, ctx)');
  expect(server).toContain("openOAuthLoginOnNode");
  expect(server).toContain("state?.openedOnNode");
});
