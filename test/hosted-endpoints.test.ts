// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import test from "node:test";
import { hostedEndpoints, DEFAULT_HOSTED_DOMAIN } from "../src/hosted-endpoints.mjs";

// These tests lock in two Bivy Core promises (docs/open-source-cloud-plan.md
// Phase 2): a node computes all of its hosted config WITHOUT requiring any cloud
// env var (local-only mode never depends on Bivy Cloud), and every hosted
// default is overridable for self-hosting.

test("local-only: endpoints resolve with an empty env, requiring no cloud vars", () => {
  // Pass a completely empty env — no BIVY_* / cloud variables set at all.
  const ep = hostedEndpoints({});
  assert.equal(ep.domain, DEFAULT_HOSTED_DOMAIN);
  assert.equal(ep.controlPlane, `https://app.${DEFAULT_HOSTED_DOMAIN}`);
  assert.equal(ep.relay, `wss://relay.${DEFAULT_HOSTED_DOMAIN}`);
  // clientBaseUrl falls back to the control plane when unset.
  assert.equal(ep.clientBaseUrl, ep.controlPlane);
  // Nothing threw and every field is a usable absolute URL — a node can boot and
  // run locally with zero cloud configuration.
  for (const url of [ep.controlPlane, ep.relay, ep.clientBaseUrl]) {
    assert.doesNotThrow(() => new URL(url));
  }
});

test("self-host: BIVY_HOSTED_DOMAIN re-points every derived endpoint", () => {
  const ep = hostedEndpoints({ BIVY_HOSTED_DOMAIN: "bivy.example.com" });
  assert.equal(ep.domain, "bivy.example.com");
  assert.equal(ep.controlPlane, "https://app.bivy.example.com");
  assert.equal(ep.relay, "wss://relay.bivy.example.com");
  assert.equal(ep.clientBaseUrl, "https://app.bivy.example.com");
});

test("self-host: per-URL overrides win over the derived domain", () => {
  const ep = hostedEndpoints({
    BIVY_HOSTED_DOMAIN: "bivy.example.com",
    BIVY_CONTROL_PLANE_URL: "https://cp.internal:8443",
    BIVY_RELAY_URL: "wss://relay.internal:9443",
    BIVY_CLIENT_BASE_URL: "https://ui.internal",
  });
  assert.equal(ep.controlPlane, "https://cp.internal:8443");
  assert.equal(ep.relay, "wss://relay.internal:9443");
  assert.equal(ep.clientBaseUrl, "https://ui.internal");
});

test("normalization: domain scheme is stripped and trailing slashes trimmed", () => {
  const ep = hostedEndpoints({
    BIVY_HOSTED_DOMAIN: "https://bivy.example.com/",
    BIVY_CONTROL_PLANE_URL: "https://cp.internal/",
  });
  assert.equal(ep.domain, "bivy.example.com");
  assert.equal(ep.controlPlane, "https://cp.internal");
  // relay is still derived from the cleaned domain.
  assert.equal(ep.relay, "wss://relay.bivy.example.com");
});
