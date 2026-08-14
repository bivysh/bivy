// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralCatalogEntry } from "../src/ephemeral.js";

describe("ephemeral provider positioning", () => {
  it.each(["aws", "hetzner", "fly"])("marks %s as stable BYO cloud", (id) => {
    expect(ephemeralCatalogEntry(id)).toMatchObject({ computeClass: "byo-cloud", maturity: "stable" });
  });

  it.each(["sprites", "e2b"])("marks %s as experimental managed compute", (id) => {
    expect(ephemeralCatalogEntry(id)).toMatchObject({ computeClass: "managed-compute", maturity: "experimental" });
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
