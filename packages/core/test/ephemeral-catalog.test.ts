// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralCatalogEntry } from "../src/ephemeral-catalog.js";

describe("ephemeral provider positioning", () => {
  it.each(["aws", "hetzner", "fly"])("marks %s as stable BYO cloud", (id) => {
    expect(ephemeralCatalogEntry(id)).toMatchObject({ computeClass: "byo-cloud" });
  });


  it("flags Hetzner hostedOnly — guest shutdown does not stop billing", () => {
    expect(ephemeralCatalogEntry("hetzner")).toMatchObject({ hostedOnly: true });
  });

  it.each(["aws", "fly"])("%s is not flagged hostedOnly", (id) => {
    expect(ephemeralCatalogEntry(id)?.hostedOnly).toBeFalsy();
  });

  it.each(["sprites", "e2b"])("does not expose removed managed sandbox provider %s", (id) => {
    expect(ephemeralCatalogEntry(id)).toBeNull();
  });
});
