// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  credentialItemFromBrowserModelKey,
  credentialItemFromNodeSummary,
  credentialItemId,
  mergeCredentialItems,
  migrateBrowserModelKeys,
  migrateNodeCredentialSummaries,
  type CredentialItem,
} from "../src/index.js";

function item(label: string, availability: CredentialItem["availability"] = { account: true, device: false, nodes: [] }): CredentialItem {
  return {
    id: credentialItemId("anthropic", label), provider: "anthropic", label,
    kind: "api_key", origins: ["node"], availability,
  };
}

function summary(over: Record<string, unknown> = {}) {
  return {
    provider: "anthropic", label: "default", kind: "api_key" as const,
    sync: "node" as const, origin: "bivy" as const, testable: true, ...over,
  };
}

describe("logical credential identity and migration", () => {
  it("creates stable ids from normalized provider and label", () => {
    expect(credentialItemId(" Anthropic ", " Work Key ")).toBe(credentialItemId("anthropic", "work key"));
    expect(credentialItemId("anthropic")).toBe("credential:v1:anthropic:default");
    expect(() => credentialItemId(" ")).toThrow("provider");
  });

  it("migrates browser entries without retaining secret material", () => {
    const migrated = credentialItemFromBrowserModelKey({
      provider: " OpenAI ", key: "sk-super-secret", scope: "account", updatedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(migrated).toMatchObject({
      id: "credential:v1:openai:default", provider: "openai", label: "default", kind: "api_key",
      origins: ["browser"], availability: { account: true, device: true, nodes: [] },
      updatedAt: Date.parse("2026-01-02T03:04:05.000Z"),
    });
    expect(JSON.stringify(migrated)).not.toContain("sk-super-secret");
  });

  it("preserves labeled browser accounts as distinct logical items", () => {
    const migrated = migrateBrowserModelKeys([
      { provider: "anthropic", label: "work", key: "one" },
      { provider: "anthropic", label: "personal", key: "two" },
    ]);
    expect(migrated.map((entry) => entry.id)).toEqual([
      "credential:v1:anthropic:personal",
      "credential:v1:anthropic:work",
    ]);
    expect(JSON.stringify(migrated)).not.toContain("one");
    expect(JSON.stringify(migrated)).not.toContain("two");
  });

  it("preserves legacy account-by-default semantics and device-only scope", () => {
    expect(credentialItemFromBrowserModelKey({ provider: "a", configured: true })?.availability).toEqual({ account: true, device: true, nodes: [] });
    expect(credentialItemFromBrowserModelKey({ provider: "a", key: "x", scope: "device" })?.availability).toEqual({ account: false, device: true, nodes: [] });
    expect(credentialItemFromBrowserModelKey({ provider: "a", configured: false })).toBeUndefined();
    expect(credentialItemFromBrowserModelKey({ provider: " " })).toBeUndefined();
  });

  it("migrates node summaries, normalizes provider:label, and omits refs", () => {
    const migrated = credentialItemFromNodeSummary(summary({
      provider: " OpenAI ", label: " Work ", kind: "reference", ref: "op://private/path",
      sync: "account", expiresAt: 42, lastVerifiedAt: 41, lastVerifiedOk: false,
    }) as never, "node-b");
    expect(migrated).toEqual({
      id: "credential:v1:openai:work", provider: "openai", label: "work", kind: "reference",
      origins: ["node"], availability: { account: true, device: false, nodes: ["node-b"] },
      expiresAt: 42, testable: true, lastVerifiedAt: 41, lastVerifiedOk: false,
    });
    expect(JSON.stringify(migrated)).not.toContain("op://");
    expect(credentialItemFromNodeSummary(summary() as never, " ")).toBeUndefined();
  });

  it("converges browser default and node provider:default under one stable id", () => {
    const browser = migrateBrowserModelKeys([{ provider: "anthropic", key: "secret", scope: "account" }]);
    const nodeA = migrateNodeCredentialSummaries([summary()], "node-z");
    const nodeB = migrateNodeCredentialSummaries([summary()], "node-a");
    const merged = mergeCredentialItems(browser, nodeA, nodeB);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "credential:v1:anthropic:default", origins: ["browser", "node"],
      availability: { account: true, device: true, nodes: ["node-a", "node-z"] },
    });
  });

  it("deduplicates migration inputs and does not mutate source values", () => {
    const source = item("work", { account: false, device: false, nodes: ["z"] });
    const result = mergeCredentialItems([source], [{ ...source, availability: { account: true, device: false, nodes: ["a", "z"] } }]);
    expect(result[0]?.availability).toEqual({ account: true, device: false, nodes: ["a", "z"] });
    expect(source.availability.nodes).toEqual(["z"]);
  });
});
