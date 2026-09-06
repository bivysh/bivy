// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, timingSafeEqual } from "node:crypto";
import { verifyAutomationSignature } from "./webhooks.js";

export interface WebhookAuth {
  webhookSecret?: string;
  webhookHeader?: string;
  webhookAuthMode?: "hmac" | "header";
}

export const DEFAULT_WEBHOOK_HEADER = "x-bivy-signature-256";

/** Shared create/update validation. Secrets are write-only outside save responses. */
export function resolveWebhookAuth(input: Record<string, unknown>, current: WebhookAuth = {}): WebhookAuth {
  if (input.requireSigning !== undefined && typeof input.requireSigning !== "boolean") throw new Error("requireSigning must be a boolean");
  const mode = input.webhookAuthMode ?? current.webhookAuthMode ?? "hmac";
  if (mode !== "hmac" && mode !== "header") throw new Error("Webhook authentication must be hmac or header");
  const header = input.webhookHeader ?? current.webhookHeader ?? DEFAULT_WEBHOOK_HEADER;
  if (typeof header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(header)
    || /^(host|content-type|content-length|transfer-encoding|connection|cookie|set-cookie|x-bivy-idempotency-key|x-forwarded-.*)$/i.test(header)) {
    throw new Error("Choose a valid authentication header name, not a transport or routing header");
  }
  const secret = input.webhookSecret;
  if (secret !== undefined && (typeof secret !== "string" || secret.length < 32 || secret.length > 256 || /[^\x21-\x7e ]/.test(secret) || secret.trim() !== secret)) {
    throw new Error("Webhook secret must be 32–256 printable characters without leading or trailing spaces");
  }
  const enabled = input.requireSigning ?? Boolean(current.webhookSecret);
  return {
    webhookAuthMode: mode,
    webhookHeader: header.toLowerCase(),
    webhookSecret: enabled ? (secret as string | undefined) ?? current.webhookSecret ?? randomBytes(32).toString("base64url") : undefined,
  };
}

export function verifyWebhookAuth(auth: WebhookAuth, body: Buffer, header: string | string[] | undefined): boolean {
  if (!auth.webhookSecret) return true;
  if (typeof header !== "string") return false;
  if (auth.webhookAuthMode !== "header") return verifyAutomationSignature(auth.webhookSecret, body, header);
  const expected = Buffer.from(auth.webhookSecret);
  const supplied = Buffer.from(header);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
