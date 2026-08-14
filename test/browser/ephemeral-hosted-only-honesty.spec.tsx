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
  const model = await read("../../packages/core/src/ephemeral.ts");
  expect(model).toContain('hostedOnly?: boolean;');
  const hetznerEntryStart = model.indexOf('id: "hetzner"');
  expect(hetznerEntryStart).toBeGreaterThan(-1);
  const hetznerEntry = model.slice(hetznerEntryStart, hetznerEntryStart + 1000);
  expect(hetznerEntry).toContain("hostedOnly: true");
  expect(hetznerEntry.toLowerCase()).toContain("hosted");
});

test("Fly/AWS/Sprites/E2B are not flagged hostedOnly (they have a real device-launch backstop)", async () => {
  const model = await read("../../packages/core/src/ephemeral.ts");
  for (const id of ['id: "fly"', 'id: "sprites"', 'id: "e2b"', 'id: "aws"']) {
    const start = model.indexOf(id);
    expect(start, `${id} not found in catalog`).toBeGreaterThan(-1);
    const entry = model.slice(start, start + 800);
    expect(entry, `${id} entry should not be hostedOnly`).not.toContain("hostedOnly: true");
  }
});

test("the ephemeral sheet disables device launch and warns before connecting a hostedOnly provider", async () => {
  const view = await read("../../packages/web/src/components/Ephemeral.tsx");
  // A distinct "Hosted only" chip in the provider picker, not the generic
  // Stable/Experimental badge that implies a normal standalone launch.
  expect(view).toContain('p.hostedOnly');
  expect(view).toContain('Hosted only');
  // The connect panel warns before the user pastes a token.
  expect(view).toContain("catalog.hostedOnly &&");
  expect(view).toContain("can't be launched from this device");
  // "Use this profile" is disabled rather than leading to a launch-time
  // refusal after the user already committed to the flow.
  expect(view).toContain("disabled={busy || catalog.hostedOnly}");
  expect(view).toContain('"Device launch unavailable"');
});
