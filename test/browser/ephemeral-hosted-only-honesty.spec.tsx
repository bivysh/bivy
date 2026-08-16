// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

// docs/ephemeral-lifecycle-review.md P0: a device-launched Hetzner server has
// no independent billing cutoff (guest shutdown powers it off, not deletes
// it). launchEphemeralMachine already hard-refuses this at the API layer —
// these tests lock in that the onboarding UI says so up front, instead of
// only surfacing the refusal as a generic error after connect → pick → send.
test("the Hetzner catalog entry is flagged hostedOnly and its blurb says so", async () => {
  const model = await read("../../packages/core/src/ephemeral-catalog.ts");
  expect(model).toContain('hostedOnly?: boolean;');
  const hetznerEntryStart = model.indexOf('id: "hetzner"');
  expect(hetznerEntryStart).toBeGreaterThan(-1);
  const hetznerEntry = model.slice(hetznerEntryStart, hetznerEntryStart + 1000);
  expect(hetznerEntry).toContain("hostedOnly: true");
  expect(hetznerEntry.toLowerCase()).toContain("hosted");
});

test("hosted-only safety is separate from provider availability", async () => {
  const model = await read("../../packages/core/src/ephemeral-catalog.ts");
  for (const id of ['id: "fly"', 'id: "sprites"', 'id: "e2b"', 'id: "aws"']) {
    const start = model.indexOf(id);
    expect(start, `${id} not found in catalog`).toBeGreaterThan(-1);
    const entry = model.slice(start, start + 800);
    expect(entry, `${id} entry should not be hostedOnly`).not.toContain("hostedOnly: true");
  }
});

test("hosted-only setup uses control-plane custody instead of a device token", async () => {
  const view = await read("../../packages/web/src/components/Ephemeral.tsx");
  const settings = await read("../../packages/web/src/components/Settings.tsx");
  expect(view).toContain('p.hostedOnly');
  expect(view).toContain('Hosted only');
  expect(view).toContain('catalog.availability === "planned" || catalog.hostedOnly');
  expect(view).toContain("can't be launched with a device-held token");
  expect(view).toContain("Unattended machines");
  expect(settings).toContain("controller.validateHostedProviderCredential(providerId, value, region)");
  expect(settings).toContain("providerTokens: { [providerId]: value }");
  expect(settings).toContain("hosted teardown credential validated");
});
