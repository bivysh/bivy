// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralCatalogEntry } from "../src/ephemeral-catalog.js";

describe("ephemeral provider positioning", () => {
  it.each(["fly"])("marks %s as stable BYO cloud", (id) => {
    expect(ephemeralCatalogEntry(id)).toMatchObject({ computeClass: "byo-cloud" });
  });


  it.each(["fly"])("%s is not flagged hostedOnly", (id) => {
    expect(ephemeralCatalogEntry(id)?.hostedOnly).toBeFalsy();
  });

  it.each(["sprites", "e2b", "aws", "hetzner"])("does not expose removed provider %s", (id) => {
    expect(ephemeralCatalogEntry(id)).toBeNull();
  });
});
