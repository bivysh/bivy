// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralCatalogEntry } from "../src/ephemeral-catalog.js";

describe("ephemeral provider positioning", () => {
  it.each(["aws", "hetzner", "fly"])("marks %s as stable BYO cloud", (id) => {
    expect(ephemeralCatalogEntry(id)).toMatchObject({ computeClass: "byo-cloud", maturity: "stable", availability: "available" });
  });

  it.each(["sprites", "e2b"])("marks %s as experimental managed compute", (id) => {
    expect(ephemeralCatalogEntry(id)).toMatchObject({ computeClass: "managed-compute", maturity: "experimental" });
  });

  it("keeps Sprites in preview and E2B planned until its runtime contract is complete", () => {
    expect(ephemeralCatalogEntry("sprites")).toMatchObject({ availability: "preview" });
    expect(ephemeralCatalogEntry("e2b")).toMatchObject({ availability: "planned" });
    expect(ephemeralCatalogEntry("e2b")?.blockedReason).toMatch(/templates.*certification/i);
  });

  it("flags Hetzner hostedOnly — guest shutdown does not stop billing", () => {
    expect(ephemeralCatalogEntry("hetzner")).toMatchObject({ hostedOnly: true });
  });

  it.each(["sprites", "e2b"])("records %s idle suspension as catalog data", (id) => {
    expect(ephemeralCatalogEntry(id)).toMatchObject({ suspendsWhenIdle: true });
  });

  it.each(["aws", "fly", "sprites", "e2b"])("%s is not flagged hostedOnly", (id) => {
    expect(ephemeralCatalogEntry(id)?.hostedOnly).toBeFalsy();
  });
});
