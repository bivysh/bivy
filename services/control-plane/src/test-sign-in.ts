// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Sign-in for automated end-to-end tests (an agent checking onboarding, CI).
// Off unless the deployment sets both TEST_SIGN_IN_SECRET and
// TEST_SIGN_IN_DOMAIN. It only signs in addresses on that one reserved domain,
// so it can never reach a real person's account, and those accounts are fresh
// ones a test creates and deletes again (DELETE /account).

import { timingSafeEqual } from "node:crypto";

export interface TestSignInConfig {
  secret: string;
  /** Lower-case domain every test address must use, e.g. "agents.example.com". */
  domain: string;
}

const MIN_SECRET_LENGTH = 32;

/** The deployment's test sign-in settings, or null when it is off. */
export function testSignInConfig(env: NodeJS.ProcessEnv = process.env): TestSignInConfig | null {
  const secret = String(env.TEST_SIGN_IN_SECRET ?? "").trim();
  const domain = String(env.TEST_SIGN_IN_DOMAIN ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!secret || !domain) return null;
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`TEST_SIGN_IN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new Error("TEST_SIGN_IN_DOMAIN must be a domain name");
  return { secret, domain };
}

/** Whether an address belongs to the reserved test domain (never a real person). */
export function isTestEmail(email: string, config: TestSignInConfig | null): boolean {
  if (!config) return false;
  const at = email.lastIndexOf("@");
  return at > 0 && email.slice(at + 1).toLowerCase() === config.domain;
}

/** Constant-time check of a presented secret. */
export function testSecretMatches(presented: string, config: TestSignInConfig): boolean {
  const a = Buffer.from(String(presented ?? ""));
  const b = Buffer.from(config.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
