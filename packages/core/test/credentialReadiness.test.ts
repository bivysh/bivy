// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { deriveCredentialReadiness, redactEmail } from "../src/credentialReadiness.js";
import type { CredentialRecordSummary } from "../src/protocol.js";

function record(over: Partial<CredentialRecordSummary> = {}): CredentialRecordSummary {
  return { provider: "anthropic", label: "default", kind: "api_key", sync: "node", origin: "bivy", testable: true, ...over };
}

describe("redactEmail", () => {
  it("keeps at most two local-part characters and the full domain", () => {
    expect(redactEmail("petter@example.com")).toBe("pe****@example.com");
    expect(redactEmail("al@example.com")).toBe("a*@example.com");
  });

  it("never returns the raw email for malformed input", () => {
    expect(redactEmail("not-an-email")).toBe("•••");
    expect(redactEmail("")).toBe("•••");
  });
});

describe("deriveCredentialReadiness", () => {
  it("never fabricates an owner: a node-only credential is never attributed to an account", () => {
    const r = deriveCredentialReadiness(record({ sync: "node" }), "petter@example.com");
    expect(r.syncScope).toBe("node");
    expect(r.ownerLabel).toBe("This machine only");
    expect(r.ownerLabel).not.toContain("petter");
  });

  it("attributes an account-synced credential to the redacted signed-in email", () => {
    const r = deriveCredentialReadiness(record({ sync: "account" }), "petter@example.com");
    expect(r.ownerLabel).toBe("pe****@example.com");
    expect(r.syncScopeLabel).toBe("Synced to your account");
  });

  it("falls back to a generic label when the account email isn't known yet", () => {
    const r = deriveCredentialReadiness(record({ sync: "account" }));
    expect(r.ownerLabel).toBe("Your account");
  });

  it("derives verified state from lastVerifiedAt/lastVerifiedOk, defaulting to unverified", () => {
    expect(deriveCredentialReadiness(record()).verified).toBe("unverified");
    expect(deriveCredentialReadiness(record({ lastVerifiedAt: 1000, lastVerifiedOk: true })).verified).toBe("verified");
    expect(deriveCredentialReadiness(record({ lastVerifiedAt: 1000, lastVerifiedOk: false })).verified).toBe("failed");
  });

  it("carries testable through untouched, honest about unsupported providers", () => {
    expect(deriveCredentialReadiness(record({ testable: false })).testable).toBe(false);
  });
});
