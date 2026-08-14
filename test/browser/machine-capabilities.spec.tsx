// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function read(relativeToThisFile: string) {
  return readFile(new URL(relativeToThisFile, import.meta.url), "utf8");
}

test("the Machines settings panel renders the capability inventory section", async () => {
  const settings = await read("../../packages/web/src/components/Settings.tsx");
  expect(settings).toContain('import { MachineCapabilitiesSection } from "./MachineCapabilities.js"');
  expect(settings).toContain("<MachineCapabilitiesSection online={nodeOnline} />");
});

test("the capability section explains available/unavailable/unknown honestly and never as online/offline", async () => {
  const source = await read("../../packages/web/src/components/MachineCapabilities.tsx");
  expect(source).toContain("describeCapabilityState");
  expect(source).toContain('state === "available" ? "chip ok" : state === "unknown" ? "chip warn" : "chip"');
  // Capability availability is distinct from Machine connection status — the
  // panel's own copy must not conflate them (aside from the `online` prop
  // name itself, which is the connection gate, not a capability label).
  const capabilityCopy = source.replace(/\bonline\b/g, "");
  expect(capabilityCopy).not.toMatch(/\bOnline\b|\bOffline\b/);
});

test("the section fetches on demand (mount + refresh) rather than polling like the live stats panel", async () => {
  const source = await read("../../packages/web/src/components/MachineCapabilities.tsx");
  expect(source).not.toContain("setInterval");
  expect(source).toContain("controller.requestCapabilities()");
  expect(source).toContain('<button className="btn" disabled={!online || loading} onClick={refresh}>');
});

test("the capability request is wired end to end: PWA controller -> direct transport REST -> node route", async () => {
  const controller = await read("../../packages/web/src/store/controller.ts");
  const directTransport = await read("../../packages/core/src/transport-direct.ts");
  const server = await read("../../src/server.ts");
  expect(controller).toContain('this.send({ kind: "capabilities.get" })');
  expect(directTransport).toContain('case "capabilities.get":');
  expect(directTransport).toContain('await this.directApi("/api/capabilities")');
  expect(server).toContain('async "capabilities.get"(_msg, ctx)');
  expect(server).toContain("capabilitiesController.getCapabilities()");
});

test("an offline/unfetched Machine shows an honest empty state, not a blank panel", async () => {
  const source = await read("../../packages/web/src/components/MachineCapabilities.tsx");
  expect(source).toContain("Connect this machine to see what it unlocks for agents.");
  expect(source).toContain("Loading capabilities…");
});
