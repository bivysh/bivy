// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { resolveWebhookAuth, verifyWebhookAuth } from "../src/webhook-auth.js";

const body = Buffer.from(JSON.stringify({ version: "1", instruction: "hi" }));

// A definition without a secret (saved by an older version) accepts nothing.
assert.equal(verifyWebhookAuth({}, body, undefined), false);
assert.equal(verifyWebhookAuth({}, body, "sha256=anything"), false);
assert.equal(verifyWebhookAuth({ webhookAuthMode: "header" }, body, ""), false);

// Turning authentication off is refused on create and update.
assert.throws(() => resolveWebhookAuth({ requireSigning: false }), /must be authenticated/);
assert.throws(() => resolveWebhookAuth({ requireSigning: false }, { webhookSecret: "x".repeat(40) }), /must be authenticated/);

// Saving a secret-less definition mints a secret; an existing one is kept.
const minted = resolveWebhookAuth({}, {});
assert.ok(minted.webhookSecret && minted.webhookSecret.length >= 32);
const kept = resolveWebhookAuth({ name: "renamed" }, { webhookSecret: "k".repeat(40), webhookAuthMode: "hmac" });
assert.equal(kept.webhookSecret, "k".repeat(40));

// The minted secret signs deliveries.
const sig = `sha256=${createHmac("sha256", minted.webhookSecret!).update(body).digest("hex")}`;
assert.equal(verifyWebhookAuth(minted, body, sig), true);

console.log("✓ webhook auth: always authenticated, legacy definitions mint a secret on save");
