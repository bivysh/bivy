// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { hashToken, type AccountAuthRepository, type SelfHostOwnerRepository } from "./store.js";

type OwnerStore = SelfHostOwnerRepository & Pick<AccountAuthRepository, "findOrCreateAccount" | "getAccount" | "rateLimitExceeded">;
const passwordValid = (value: unknown): value is string => typeof value === "string" && value.length >= 12 && Buffer.byteLength(value) <= 256;

// Fixed, versioned parameters. Never accept work factors from a request or DB.
async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
export async function hashOwnerPassword(password: string): Promise<string> {
  if (!passwordValid(password)) throw new Error("Use at least 12 characters and at most 256 UTF-8 bytes.");
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyOwnerPassword(password: unknown, encoded: string): Promise<boolean> {
  if (!passwordValid(password)) return false;
  const parts = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded);
  return Boolean(parts && timingSafeEqual(await derive(password, parts[1]), Buffer.from(parts[2], "hex")));
}

export interface OwnerAuthOptions {
  store: OwnerStore;
  setupToken?: string;
  ownerEmail?: string;
  publicUrl: string;
  relayUrl: string;
  github?: boolean;
  email?: boolean;
  requireHttps?: boolean;
}

/** No platform APIs, shell access, or public first-user-wins claim endpoint. */
export function createOwnerAuthRouter(options: OwnerAuthOptions): Router {
  const { store, relayUrl } = options;
  const setupToken = options.setupToken || "";
  if (setupToken && (!/^[A-Za-z0-9_+/=-]{32,256}$/.test(setupToken))) {
    throw new Error("SELF_HOST_SETUP_TOKEN must be a random secret of 32–256 URL/base64-safe characters (generate with openssl rand -hex 32).");
  }
  const ownerEmail = (options.ownerEmail || "owner@self-host.invalid").trim().toLowerCase();
  if (setupToken && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error("Invalid SELF_HOST_OWNER_EMAIL.");
  const tokenHash = setupToken ? hashToken(setupToken) : null;
  const publicUrl = new URL(options.publicUrl);
  if (publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash ||
      (options.requireHttps && publicUrl.protocol !== "https:")) {
    throw new Error("Owner sign-in requires PUBLIC_CONTROL_PLANE_URL to be a public HTTPS origin (no path or credentials).");
  }
  const publicOrigin = publicUrl.origin;
  const router = Router();
  // Only one expensive KDF at a time per process, independently of fleet-wide
  // rate limits. This bounds memory even under distributed login attempts.
  let hashing = false;
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/status", async (_req, res) => {
    const owner = await store.selfHostOwner();
    res.json({ enabled: Boolean(tokenHash || owner), passwordConfigured: Boolean(owner), setupRequired: Boolean(tokenHash && !await store.selfHostSetupTokenUsed(tokenHash)), github: Boolean(options.github), email: Boolean(options.email) });
  });
  router.use(async (req, res, next) => {
    if (req.method !== "POST") return next();
    if (!req.is("application/json")) return res.status(415).json({ error: "Send application/json." });
    if (req.get("origin") && req.get("origin") !== publicOrigin) return res.status(403).json({ error: "Cross-origin sign-in is not allowed." });
    if (await store.rateLimitExceeded("owner-auth-ip", req.ip || "unknown", 10, 60_000) ||
        await store.rateLimitExceeded("owner-auth-global", "owner", 30, 60_000) || hashing) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "Too many sign-in attempts. Wait a minute and try again." });
    }
    next();
  });
  router.post("/setup", async (req, res) => {
    const candidate = typeof req.body?.setupToken === "string" ? req.body.setupToken : "";
    if (!tokenHash || candidate.length > 256 || !timingSafeEqual(Buffer.from(hashToken(candidate), "hex"), Buffer.from(tokenHash, "hex"))) {
      return res.status(401).json({ error: "Invalid or already-used setup secret." });
    }
    if (await store.selfHostSetupTokenUsed(tokenHash)) return res.status(401).json({ error: "Invalid or already-used setup secret." });
    if (!passwordValid(req.body?.password)) return res.status(400).json({ error: "Use at least 12 characters and at most 256 UTF-8 bytes." });
    // Recheck after asynchronous DB work; another request may have acquired it.
    if (hashing) return res.status(429).json({ error: "Sign-in is busy. Try again in a moment." });
    hashing = true;
    try {
      const passwordHash = await hashOwnerPassword(req.body.password);
      const existing = await store.selfHostOwner();
      const account = (existing && await store.getAccount(existing.accountId)) || await store.findOrCreateAccount(ownerEmail);
      if (!await store.configureSelfHostOwner({ accountId: account.id, passwordHash }, tokenHash)) {
        return res.status(401).json({ error: "Invalid or already-used setup secret." });
      }
      const token = await store.createSelfHostOwnerSession(passwordHash);
      if (!token) return res.status(409).json({ error: "Owner credentials changed. Sign in again." });
      res.json({ token, relayUrl });
    } finally { hashing = false; }
  });
  router.post("/login", async (req, res) => {
    const owner = await store.selfHostOwner();
    if (!owner || !passwordValid(req.body?.password)) return res.status(401).json({ error: "Invalid owner password." });
    if (hashing) return res.status(429).json({ error: "Sign-in is busy. Try again in a moment." });
    hashing = true;
    try {
      if (!await verifyOwnerPassword(req.body.password, owner.passwordHash)) return res.status(401).json({ error: "Invalid owner password." });
      const token = await store.createSelfHostOwnerSession(owner.passwordHash);
      if (!token) return res.status(401).json({ error: "Invalid owner password." });
      res.json({ token, relayUrl });
    } finally { hashing = false; }
  });
  return router;
}
