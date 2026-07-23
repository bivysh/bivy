// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import path from "node:path";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import Stripe from "stripe";
import webpush from "web-push";
import { type Account, type NodeRecord, type Plan, type NotificationKind, type EphemeralQueueDefault, LEGACY_PLAN_IDS, LOGIN_TOKEN_TTL_MS, NOTIFICATION_KINDS } from "./store.js";
import { countActiveAccountSessions } from "./session-count.js";
import { createStore } from "./store-factory.js";
import { parseShardUrls, shardForNode } from "./relay-shards.js";
import { safeReturnPath } from "./redirect.js";
import {
  verifyGithubSignature,
  parseGithubIssueEvent,
  pickIssueRoutingLabel,
  parseGithubCommentEvent,
  pickCommentRoutingLabel,
  parseInstallationId,
  verifySlackSignature,
  parseSlackCommand,
  applyDefaultNode,
} from "./webhooks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Bivy — Control Plane.
 *
 * Hosted service for accounts, node registry, entitlements, and billing.
 * This is the metadata service we monetize on. It stores ONLY metadata — never
 * session content, files, prompts, tool output, or model credentials.
 */

/**
 * Refuse to boot in production with insecure or data-losing defaults. Catching
 * these at startup (instead of silently running with a dev relay secret or an
 * in-memory store that drops every account on restart) is a hard requirement
 * for going live. See docs/staging-ops.md.
 */
function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const problems: string[] = [];
  if (!process.env.DATABASE_URL) {
    problems.push("DATABASE_URL is required in production (the in-memory store loses all accounts/nodes on restart)");
  }
  const relaySecret = process.env.RELAY_SECRET;
  if (!relaySecret || relaySecret === "dev-relay-secret") {
    problems.push("RELAY_SECRET must be set to a strong, non-default value (openssl rand -hex 32)");
  }
  if (process.env.ALLOW_DEV_LOGIN === "1") {
    problems.push("ALLOW_DEV_LOGIN=1 must not be set in production (it enables an unauthenticated sign-in endpoint)");
  }
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    problems.push("STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set (webhooks would be unverifiable)");
  }
  if (problems.length > 0) {
    console.error("Refusing to start: insecure production configuration:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
}

assertProductionConfig();

// Last-resort guard against a single stray async error taking down the whole
// control plane. Express's error middleware only catches errors thrown inside a
// request handler; a rejected promise in fire-and-forget code (best-effort relay
// pushes, background work, a transient DB blip outside a handler) would
// otherwise become an unhandled rejection and crash the process — turning every
// request, including relay-ticket minting, into a 502 until the container
// restarts. Log and keep serving instead.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (control plane kept alive):", reason);
});

const store = await createStore();
try {
  await store.init();
} catch (error) {
  // A failed store init is almost always a misconfigured database: a
  // DATABASE_URL pointing at a role/database that doesn't exist (e.g. after
  // renaming POSTGRES_USER/POSTGRES_DB on an already-initialized volume),
  // wrong password, or postgres not reachable. Surface it explicitly instead
  // of crashing with an opaque unhandled-rejection so the deploy logs say why.
  console.error(
    "Refusing to start: store initialization failed. Check DATABASE_URL " +
      "(role/database must exist and be reachable):\n  " +
      String(error instanceof Error ? (error.stack ?? error.message) : error),
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 4400);
const relayPublicUrl = process.env.RELAY_PUBLIC_URL ?? "ws://localhost:4500";
// Relay shard URLs (docs/scaling.md). Defaults to the single relayPublicUrl, so
// behavior is unchanged until RELAY_SHARD_URLS lists more than one relay. A node
// and all its clients are routed to the same shard by hashing the nodeId.
const relayShardUrls = parseShardUrls(process.env);
function relayUrlForNode(nodeId: string | null | undefined): string {
  return shardForNode(nodeId, relayShardUrls);
}

function relayHttpUrl(relayUrl: string): string {
  if (relayUrl.startsWith("wss://")) return `https://${relayUrl.slice("wss://".length)}`;
  if (relayUrl.startsWith("ws://")) return `http://${relayUrl.slice("ws://".length)}`;
  return relayUrl;
}

async function notifyRelaysWorkAvailable(accountId: string, item: { id: string; label: string }) {
  // Best-effort push: relay-connected nodes get an immediate hint and then fetch
  // + atomically claim via /node/work. Fallback polling still guarantees pickup
  // if the relay/shard is offline or the node is disconnected.
  await Promise.allSettled(
    relayShardUrls.map(async (url) => {
      await fetch(`${relayHttpUrl(url).replace(/\/$/, "")}/internal/work-available`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.RELAY_SECRET ?? "dev-relay-secret"}` },
        body: JSON.stringify({ accountId, id: item.id, label: item.label }),
      });
    }),
  );
}
if (relayShardUrls.length > 1) {
  console.log(`[relay] sharding across ${relayShardUrls.length} relays: ${relayShardUrls.join(", ")}`);
}
// TTL for a device-linking grant minted from the QR. Node-scoped and expiring;
// default 30 days so durable single-node reconnect still works.
const LINK_GRANT_TTL_MS = Number(process.env.LINK_GRANT_TTL_MS ?? 30 * 24 * 60 * 60_000);
function normalizePublicUrl(value: string): string {
  return value.replace(/\/$/, "");
}

const publicControlPlaneUrl = process.env.PUBLIC_CONTROL_PLANE_URL ? normalizePublicUrl(process.env.PUBLIC_CONTROL_PLANE_URL) : undefined;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const vapidPublicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || "";
const vapidSubject = process.env.WEB_PUSH_SUBJECT || "mailto:support@bivy.sh";
const webPushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);
if (webPushEnabled) webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
// Whether paid-plan entitlements are enforced (Bivy Cloud). Mirrors the relay's
// flag (services/relay/src/index.ts). When it's off — the self-host / no-billing
// default (see docs/self-host.md, ENFORCE_ENTITLEMENTS=0) — there is no paid tier
// to gate against and every signed-in account is "free", so gating push on
// `pushEnabled` would make Web Push impossible to use on a self-hosted stack even
// with VAPID keys configured. Off ⇒ push is available to any account (still
// requires VAPID keys / webPushEnabled); on ⇒ push stays gated to paid plans.
const enforceEntitlements = process.env.ENFORCE_ENTITLEMENTS === "1";
async function accountPushAllowed(accountId: string): Promise<boolean> {
  if (!enforceEntitlements) return true;
  return (await store.entitlements(accountId)).pushEnabled;
}

// Start of the current calendar month in UTC, as an ISO timestamp — the reset
// boundary for the free-tier work-queue quota. Computed rather than stored, so
// there is no counter to reset and no cron: the count is just claimed items with
// `claimedAt >= this`.
function startOfMonthUtcIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// The account's hosted work-queue run allowance for the current UTC month.
// `limit` is the plan cap (undefined ⇒ unlimited — paid plans), `used` the runs
// already started this month, `exhausted` whether a new run must be refused.
// Quota is only ENFORCED under `ENFORCE_ENTITLEMENTS=1` (Bivy Cloud); on a
// self-host stack `exhausted` is always false so runners go unlimited, but `used`
// is still reported for display. One claimed item = one run.
async function workQueueAllowance(accountId: string): Promise<{ limit?: number; used: number; exhausted: boolean }> {
  const limit = (await store.entitlements(accountId)).workQueueMonthlyLimit;
  if (typeof limit !== "number") return { limit: undefined, used: 0, exhausted: false };
  const used = await store.countWorkRunsSince(accountId, startOfMonthUtcIso());
  return { limit, used, exhausted: enforceEntitlements && used >= limit };
}
const stripePrices: Partial<Record<Plan, string>> = {
  pro: process.env.STRIPE_PRICE_PRO,
  team: process.env.STRIPE_PRICE_TEAM,
};

// Plan ids arrive from two places whose version we do not control: the published
// CLI (packages/core's billingCheckout) and the dev-mode billing webhook used by
// tests and local stacks. Both sent `individual` before the plan was renamed to
// `pro`, so translate rather than 400 a client that is merely older than this
// deploy. Unrecognised ids pass through unchanged and fail the caller's own
// validation. Accounts already stored under the old id are migrated at boot.
function normalizePlan(plan: string): string {
  return LEGACY_PLAN_IDS[plan] ?? plan;
}
const app = express();

// Operational counters for the relay ticket mint path. These are intentionally
// coarse (no tokens, no payloads) and exist to distinguish app/store failures
// from reverse-proxy 502s when nodes are reconnecting.
const relayTicketMetrics = {
  nodeMinted: 0,
  nodeFailed: 0,
  clientMinted: 0,
  clientFailed: 0,
};

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=()");
  // The hosted PWA keeps JS/CSS in external static assets so CSP can avoid
  // unsafe-inline while still allowing API, relay, and push-notification flows.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      // xterm.js (terminal overlay) injects a <style> for cell metrics and sets
      // per-cell inline styles; without 'unsafe-inline' columns mis-measure and
      // TUIs render misaligned. script-src stays 'self' (the XSS-critical one).
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss: ws:",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      // github.com is allowed so the GitHub App one-click flow can POST its
      // manifest to GitHub's app-creation page; everything else stays 'self'.
      "form-action 'self' https://github.com",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  next();
}
app.use(securityHeaders);
app.use("/billing/webhook", express.raw({ type: "application/json", limit: "1mb" }));
// Inbound third-party webhooks need the RAW body to verify their HMAC signature,
// so capture it before the JSON parser runs (GitHub sends JSON, Slack sends
// urlencoded — match any content-type).
app.use("/webhooks", express.raw({ type: () => true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
// Liveness: the process is up and serving. Deliberately does NOT touch the
// database — restarting the app can't fix an unreachable DB, so tying liveness
// to the DB would just kill a healthy process during a transient blip and drop
// every live WebSocket. Readiness (below) is where DB reachability belongs.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/metrics", (_req, res) => {
  res.json({ ok: true, relayTickets: relayTicketMetrics });
});

// Readiness: the process is up AND its backing store is reachable. A DB outage
// (the "getaddrinfo EAI_AGAIN postgres" symptom) makes this return 503 so the
// container reports unhealthy — a real signal to look at, instead of /healthz
// staying green while every request 500s. Point the deploy healthcheck here.
app.get("/readyz", asyncHandler(async (_req, res) => {
  try {
    await store.ping();
    res.json({ ok: true });
  } catch (error) {
    console.error("Readiness check failed (store unreachable):", error);
    res.status(503).json({ error: "Service not ready." });
  }
}));
function noStorePwaShell(res: Response) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

// Serve the React/Vite PWA (@bivy/web) — Bivy's single web client — at the root
// so the bare domain (app.bivy.sh) loads the app directly. It renders its own
// sign-in screen on a cold visit; the GitHub OAuth callback and magic-link
// consume redirect back here with the session in the URL fragment. The built
// app is bundled into public/react by the Docker image (see
// deploy/Dockerfile.control-plane); it's absent in a bare checkout, so `/`
// falls through to a plain notice until the image has built it.
const reactAppDir = path.join(__dirname, "..", "public", "react");
const reactIndexFile = path.join(reactAppDir, "index.html");
const hasReactApp = fs.existsSync(reactIndexFile);
app.get("/", (_req, res) => {
  noStorePwaShell(res);
  if (hasReactApp) return res.sendFile(reactIndexFile);
  res.status(503).type("html").send("<h1>Bivy</h1><p>Web client not built.</p>");
});
if (hasReactApp) {
  // The app's own hashed assets, service worker and manifest. Never long-cache
  // the entry document or the SW so a deploy is picked up on the next load.
  app.use(
    express.static(reactAppDir, {
      index: false,
      setHeaders(res, filePath) {
        const name = path.basename(filePath);
        if (name === "index.html" || name === "sw.js" || name.startsWith("workbox-")) noStorePwaShell(res);
      },
    }),
  );
}
// Shared static assets the app references from root (icons, tent.png, …). Kept
// separate from the built bundle, which doesn't carry them.
app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));

// SPA deep links: the client routes `/sessions/new` and `/sessions/:id` in the
// browser, so a cold load or copied URL on those paths must serve the app shell.
// The regex requires a segment after `/sessions/`, so it can't shadow the
// `GET /sessions` JSON API (exact path) below.
if (hasReactApp) {
  app.get(/^\/sessions\/.+/, (_req, res) => {
    noStorePwaShell(res);
    res.sendFile(reactIndexFile);
  });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers["authorization"] ?? "").trim());
  return m ? m[1].trim() : null;
}

function baseUrl(req: Request): string {
  if (publicControlPlaneUrl) return publicControlPlaneUrl;
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "http").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${port}`).split(",")[0];
  return normalizePublicUrl(`${proto}://${host}`);
}

function validEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(email);
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );
}

// The installed PWA opens this OAuth tab itself (window.open) and polls for
// completion, so once sign-in lands the tab has done its job. Closing it hands
// focus straight back to the app instead of stranding the user on a dead-end
// page. Only a script-opened window may close itself — a tab opened from an
// email/QR link (the CLI/terminal device flow) can't, so it keeps the message.
// Kept as a constant so we can whitelist exactly this snippet via a CSP hash:
// the global script-src is 'self' only, which would otherwise block it.
const signedInCloseScript = `setTimeout(function () { try { window.close(); } catch (e) { /* not closable */ } }, 600);`;
const signedInScriptHash = `sha256-${createHash("sha256").update(signedInCloseScript).digest("base64")}`;

function deviceSignedInHtml(email: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed in</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0f20;color:#eef2ff;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#0f1530;border:1px solid #233056;border-radius:16px;padding:32px 40px;text-align:center;max-width:360px}
h1{font-size:20px;margin:0 0 8px}p{color:#9aa6cf;margin:6px 0}</style></head>
<body><div class="card"><h1>✓ You're signed in</h1><p>${escapeHtml(email)}</p><p>Return to Bivy (the app or your terminal) — it finishes automatically. You can close this tab.</p></div>
<script>${signedInCloseScript}</script>
</body></html>`;
}

// Send the device sign-in page, relaxing this one response's CSP just enough to
// run the self-close snippet (whitelisted by its hash); the global script-src
// stays 'self'-only for every other route.
function sendDeviceSignedIn(res: Response, email: string): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self' '${signedInScriptHash}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  res.type("html").send(deviceSignedInHtml(email));
}

function stripePriceToPlan(priceId: string | null | undefined): Plan | undefined {
  if (priceId && stripePrices.pro && priceId === stripePrices.pro) return "pro";
  if (priceId && stripePrices.team && priceId === stripePrices.team) return "team";
  return undefined;
}

function planFromSubscription(subscription: Stripe.Subscription): Plan {
  const priceId = subscription.items.data[0]?.price.id;
  // The metadata fallback reads a value Stripe has been holding since the
  // subscription was created, so subscriptions opened before the rename still say
  // `individual` there. Normalize it — this is live data we cannot backfill.
  const fromMetadata = subscription.metadata.plan
    ? (normalizePlan(subscription.metadata.plan) as Plan)
    : undefined;
  return stripePriceToPlan(priceId) ?? fromMetadata ?? "free";
}

function subscriptionIsPaid(subscription: Stripe.Subscription): boolean {
  return ["active", "trialing"].includes(subscription.status);
}

async function syncStripeBillingForAccount(account: Account): Promise<Account> {
  if (!stripe) return account;
  const customerIds: string[] = [];
  if (account.stripeCustomerId) customerIds.push(account.stripeCustomerId);
  if (!customerIds.length) {
    const customers = await stripe.customers.list({ email: account.email, limit: 10 });
    for (const c of customers.data) if (!c.deleted) customerIds.push(c.id);
  }
  for (const customerId of customerIds) {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
    const paid = subs.data.find(subscriptionIsPaid);
    if (paid) {
      await store.setSubscriptionState(account.id, {
        plan: planFromSubscription(paid),
        stripeCustomerId: customerId,
        stripeSubscriptionId: paid.id,
        subscriptionStatus: paid.status,
      });
      return (await store.getAccount(account.id)) ?? account;
    }
  }
  if (account.stripeCustomerId) {
    await store.setSubscriptionState(account.id, {
      plan: "free",
      stripeCustomerId: account.stripeCustomerId,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
    });
    return (await store.getAccount(account.id)) ?? account;
  }
  return account;
}

async function sendMagicLinkEmail(email: string, loginUrl: string) {
  const resendApiKey = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_EMAIL_FROM ?? "Bivy <login@bivy.local>";
  const subject = "Sign in to Bivy";
  const text = `Sign in to Bivy:\n\n${loginUrl}\n\nThis link expires in 15 minutes.`;
  const html = `<p>Sign in to Bivy:</p><p><a href="${loginUrl}">Continue</a></p><p>This link expires in 15 minutes.</p>`;

  if (!resendApiKey) {
    if (process.env.NODE_ENV === "production") throw new Error("RESEND_API_KEY is required for production magic-link auth");
    console.log(`[auth] Magic link for ${email}: ${loginUrl}`);
    return { sent: false, devLink: loginUrl };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: email, subject, text, html }),
  });
  if (!response.ok) throw new Error(`Email send failed: ${response.status} ${await response.text()}`);
  return { sent: true };
}

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
}

// --- GitHub OAuth sign-in -----------------------------------------------------
// Primary sign-in for the developer ICP. We resolve the account by the user's
// PRIMARY VERIFIED GitHub email so a GitHub login and a magic-link login for the
// same address land on the SAME account. Minimal scope at login (read:user,
// user:email); repo scope is requested later, only when a repo is connected to
// the work queue. See docs/product-definition.md and docs/DEVELOPMENT_PLAN.md C1.
const githubClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
const githubConfigured = Boolean(githubClientId && githubClientSecret);

// Short-lived CSRF/login state. In-memory is fine for a single instance; a
// multi-instance deployment should move this to the store (follow-up).
const githubOauthStates = new Map<string, { deviceId?: string; returnPath?: string; expiresAt: number }>();
function rememberOauthState(deviceId?: string, returnPath?: string): string {
  const state = randomBytes(24).toString("base64url");
  githubOauthStates.set(state, { deviceId, returnPath, expiresAt: Date.now() + 10 * 60_000 });
  return state;
}
function takeOauthState(state: string): { deviceId?: string; returnPath?: string } | undefined {
  const rec = githubOauthStates.get(state);
  if (!rec) return undefined;
  githubOauthStates.delete(state); // single use
  if (rec.expiresAt < Date.now()) return undefined;
  return { deviceId: rec.deviceId, returnPath: rec.returnPath };
}

// Why a GitHub sign-in couldn't resolve an email. `token-exchange` means we never
// got a usable access token (bad client secret, redirect_uri/PUBLIC_CONTROL_PLANE_URL
// mismatch, expired code); `no-verified-email` means the token worked but no verified
// address came back (missing user:email scope, SSO not authorized, or no verified email).
type GithubEmailFailure = "token-exchange" | "no-verified-email";

/**
 * Exchange an OAuth code for the user's primary verified GitHub email.
 * Returns `{ email }` on success or `{ reason }` on failure. Every failure branch
 * logs server-side: otherwise all three failure modes look identical to the user
 * ("could not read a verified email") and are impossible to diagnose from a fresh
 * install — which step actually broke never reaches the operator.
 */
async function githubPrimaryEmail(code: string, redirectUri: string): Promise<{ email?: string; reason?: GithubEmailFailure }> {
  let tokenRes: Awaited<ReturnType<typeof fetch>>;
  try {
    tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: githubClientId, client_secret: githubClientSecret, code, redirect_uri: redirectUri }),
    });
  } catch (err) {
    console.warn(`[auth] GitHub token exchange request failed: ${String(err)}`);
    return { reason: "token-exchange" };
  }
  // GitHub reports token errors as HTTP 200 with an { error, error_description } body,
  // so inspect the body — checking only tokenRes.ok would treat a failure as success.
  const tokenData = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    console.warn(`[auth] GitHub token exchange returned no access_token (status ${tokenRes.status}, error=${tokenData.error ?? "?"}: ${tokenData.error_description ?? ""}). Check GITHUB_OAUTH_CLIENT_SECRET and that PUBLIC_CONTROL_PLANE_URL matches the registered callback.`);
    return { reason: "token-exchange" };
  }

  const ghHeaders = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "bivy" };
  const emailsRes = await fetch("https://api.github.com/user/emails", { headers: ghHeaders });
  if (emailsRes.ok) {
    const emails = (await emailsRes.json().catch(() => [])) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const chosen = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    if (chosen?.email) return { email: chosen.email.toLowerCase() };
    console.warn(`[auth] GitHub /user/emails returned ${emails.length} address(es) but none were verified`);
  } else {
    // Non-OK here almost always means the granted token lacks the user:email scope
    // (or the OAuth grant wasn't SSO-authorized for the org).
    console.warn(`[auth] GitHub /user/emails failed with status ${emailsRes.status} — the token is likely missing the user:email scope`);
  }
  // Fallback to the public profile email if the emails endpoint returned nothing usable.
  const userRes = await fetch("https://api.github.com/user", { headers: ghHeaders });
  if (userRes.ok) {
    const user = (await userRes.json().catch(() => ({}))) as { email?: string | null };
    if (user.email) return { email: user.email.toLowerCase() };
    console.warn("[auth] GitHub /user returned no public email (email set to private and no verified address was readable)");
  } else {
    console.warn(`[auth] GitHub /user failed with status ${userRes.status}`);
  }
  return { reason: "no-verified-email" };
}

// --- Auth middlewares ---------------------------------------------------

const requireUser = asyncHandler(async (req, res, next) => {
  const account = await store.accountFromSession(bearer(req));
  if (!account) return res.status(401).json({ error: "Unauthorized" });
  (req as Request & { account: Account }).account = account;
  next();
});

const requireNode = asyncHandler(async (req, res, next) => {
  const node = await store.nodeFromEnrollmentToken(bearer(req));
  if (!node) return res.status(401).json({ error: "Unauthorized node" });
  (req as Request & { node: NodeRecord }).node = node;
  next();
});

// --- Accounts -----------------------------------------------------------

// Passwordless email sign-in. In production this requires RESEND_API_KEY.
app.post("/auth/magic-link/start", asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Invalid email" });

  const loginToken = await store.createLoginToken(email);
  const loginUrl = `${baseUrl(req)}/auth/magic-link/consume?token=${encodeURIComponent(loginToken)}`;
  const result = await sendMagicLinkEmail(email, loginUrl);
  res.json({ ok: true, sent: result.sent, ...(result.devLink ? { devLink: result.devLink } : {}) });
}));

app.post("/auth/magic-link/consume", asyncHandler(async (req, res) => {
  const loginToken = String(req.body?.token ?? "").trim();
  const account = await store.consumeLoginToken(loginToken);
  if (!account) return res.status(401).json({ error: "Invalid or expired login token" });
  const token = await store.createSession(account.id);
  res.json({ ok: true, token, account: { id: account.id, email: account.email, plan: account.plan } });
}));

app.get("/auth/magic-link/consume", asyncHandler(async (req, res) => {
  const loginToken = String(req.query?.token ?? "").trim();
  const deviceId = String(req.query?.device ?? "").trim();
  const account = await store.consumeLoginToken(loginToken);
  if (!account) return res.status(401).type("html").send("<h1>Invalid or expired login link</h1>");
  // Device-login flow (hands-free CLI sign-in): mark the pending device login
  // complete and tell the user to return to their terminal. No session is
  // embedded here — the CLI mints it when it polls.
  if (deviceId) {
    await store.completeDeviceLogin(deviceId, account.id);
    return sendDeviceSignedIn(res, account.email);
  }
  const session = await store.createSession(account.id);
  const payload = b64urlJson({ session, controlPlane: baseUrl(req), relay: relayPublicUrl });
  res.redirect(`/#${payload}`);
}));

// Hands-free CLI sign-in. The CLI starts a device login, the user clicks the
// emailed link in a browser, and the CLI polls for completion. The session is
// minted only at successful poll time, so no bearer is stored at rest.
app.post("/auth/device/start", asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Invalid email" });

  const loginToken = await store.createLoginToken(email);
  const { deviceId, deviceSecret } = await store.createDeviceLogin();
  const loginUrl = `${baseUrl(req)}/auth/magic-link/consume?token=${encodeURIComponent(loginToken)}&device=${encodeURIComponent(deviceId)}`;
  const result = await sendMagicLinkEmail(email, loginUrl);
  res.json({
    ok: true,
    sent: result.sent,
    deviceId,
    deviceSecret,
    intervalMs: 2000,
    expiresInMs: LOGIN_TOKEN_TTL_MS,
    ...(result.devLink ? { devLink: result.devLink } : {}),
  });
}));

app.post("/auth/device/poll", asyncHandler(async (req, res) => {
  const deviceId = String(req.body?.deviceId ?? "").trim();
  const deviceSecret = String(req.body?.deviceSecret ?? "").trim();
  if (!deviceId || !deviceSecret) return res.status(400).json({ error: "Missing device credentials" });
  const result = await store.pollDeviceLogin(deviceId, deviceSecret);
  if (result.status !== "complete") return res.json(result);

  const account = await store.accountFromSession(result.token);
  if (!account) return res.status(500).json({ error: "Could not create account session" });
  res.json({
    ...result,
    account: {
      id: account.id,
      email: account.email,
      plan: account.plan,
      subscriptionStatus: account.subscriptionStatus,
      planUpdatedAt: account.planUpdatedAt,
    },
  });
}));

// Begin GitHub OAuth. `?device=<id>` ties the login to a hands-free device login
// (CLI / app) created via createDeviceLogin; otherwise it's a browser sign-in.
app.get("/auth/github/start", (req, res) => {
  if (!githubConfigured) return res.status(501).type("html").send("<h1>GitHub sign-in is not configured</h1><p>Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.</p>");
  const deviceId = String(req.query.device ?? "").trim() || undefined;
  // Land back on the path the sign-in started from (for a client served under a
  // sub-path) instead of always dumping to root. Ignored for the device flow,
  // which finishes in-place via polling rather than a redirect.
  const returnPath = deviceId ? undefined : safeReturnPath(req.query.return, "/");
  const state = rememberOauthState(deviceId, returnPath);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", githubClientId!);
  url.searchParams.set("redirect_uri", `${baseUrl(req)}/auth/github/callback`);
  url.searchParams.set("scope", "read:user user:email"); // minimal scope at login
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  res.redirect(url.toString());
});

app.get("/auth/github/callback", asyncHandler(async (req, res) => {
  if (!githubConfigured) return res.status(501).json({ error: "GitHub sign-in not configured" });
  const code = String(req.query.code ?? "").trim();
  const state = String(req.query.state ?? "").trim();
  const stored = takeOauthState(state);
  if (!code || !stored) {
    return res.status(400).type("html").send("<h1>Sign-in failed</h1><p>Invalid or expired request. Please try again.</p>");
  }
  const { email, reason } = await githubPrimaryEmail(code, `${baseUrl(req)}/auth/github/callback`);
  if (!email || !validEmail(email)) {
    // Distinct copy per failure mode so the browser hints at the real cause; the
    // server logs (see githubPrimaryEmail) carry the operator-facing detail.
    const detail =
      reason === "token-exchange"
        ? "Couldn't complete GitHub sign-in — the authorization code could not be exchanged. This is a server configuration issue; please try again in a moment."
        : "GitHub didn't return a verified email. Make sure your GitHub account has a verified email address and that you granted the email permission, then try again.";
    return res.status(400).type("html").send(`<h1>Sign-in failed</h1><p>${detail}</p>`);
  }
  // Resolve by verified email → links GitHub and magic-link to one account.
  const account = await store.findOrCreateAccount(email);
  if (stored.deviceId) {
    await store.completeDeviceLogin(stored.deviceId, account.id);
    return sendDeviceSignedIn(res, account.email);
  }
  const session = await store.createSession(account.id);
  const payload = b64urlJson({ session, controlPlane: baseUrl(req), relay: relayPublicUrl });
  // Re-sanitize on the way out (defense in depth): the return path was validated
  // at /start, but never trust a stored value verbatim when building a redirect.
  res.redirect(`${safeReturnPath(stored.returnPath, "/")}#${payload}`);
}));

// Hands-free GitHub sign-in for the CLI / app: start a deviceless device login,
// hand back a GitHub authorize URL (tied to that device via ?device=), and let
// the caller poll /auth/device/poll until the GitHub callback completes it.
app.post("/auth/device/github/start", asyncHandler(async (req, res) => {
  if (!githubConfigured) return res.status(501).json({ error: "GitHub sign-in not configured" });
  const { deviceId, deviceSecret } = await store.createDeviceLogin();
  const authorizeUrl = `${baseUrl(req)}/auth/github/start?device=${encodeURIComponent(deviceId)}`;
  res.json({ ok: true, deviceId, deviceSecret, authorizeUrl, intervalMs: 2000, expiresInMs: LOGIN_TOKEN_TTL_MS });
}));

// DEV login remains available for local/staging unless disabled explicitly.
app.post("/auth/dev-login", asyncHandler(async (req, res) => {
  if (process.env.DISABLE_DEV_LOGIN === "1" || (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_LOGIN !== "1")) {
    return res.status(404).json({ error: "Dev login disabled" });
  }
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Invalid email" });
  const account = await store.findOrCreateAccount(email);
  const token = await store.createSession(account.id);
  res.json({ ok: true, token, account: { id: account.id, email: account.email, plan: account.plan } });
}));

// Sign out: revoke the presented account session so a lost/compromised device
// can be cut off. Idempotent — returns ok even if the token was already gone.
// When the client sends its own device public key, also drop the paired-device
// record so signing out frees the account's device slot (otherwise the "Device
// limit" count would keep climbing across sign-ins).
app.post("/auth/logout", asyncHandler(async (req, res) => {
  const token = bearer(req);
  if (token) {
    const devicePublicKeyB64 = String(req.body?.devicePublicKeyB64 ?? "").trim();
    if (devicePublicKeyB64) {
      // Resolve the account before revoking the session, since removal is
      // account-scoped. Best effort: a failure here must not block sign-out.
      const account = await store.accountFromSession(token);
      if (account) {
        try {
          await store.removePairedDevice(account.id, devicePublicKeyB64);
        } catch {
          /* ignore — still revoke the session below */
        }
      }
    }
    await store.revokeSession(token);
  }
  res.json({ ok: true });
}));

// List the account's paired devices for the device manager. Each id is the
// device's public key (base64url), which DELETE /devices/:id addresses.
app.get("/devices", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  res.json(await store.listPairedDevices(account.id));
}));

// Remove (sign out) a paired device, freeing a device slot. 404 if the account
// has no such device.
app.delete("/devices/:id", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const id = decodeURIComponent(String(req.params.id ?? "")).trim();
  const removed = id ? await store.removePairedDevice(account.id, id) : false;
  res.status(removed ? 200 : 404).json({ ok: removed });
}));

app.get("/me", requireUser, asyncHandler(async (req, res) => {
  const account = await syncStripeBillingForAccount((req as Request & { account: Account }).account);
  res.json({
    account: {
      id: account.id,
      email: account.email,
      plan: account.plan,
      subscriptionStatus: account.subscriptionStatus,
      planUpdatedAt: account.planUpdatedAt,
    },
    entitlements: await store.entitlements(account.id),
    counts: {
      nodes: (await store.listNodes(account.id)).length,
      devices: await store.countPairedDevices(account.id),
      // Active-session count only (excludes saved / offline-node entries) so the
      // "Session limit reached — X/N" banner matches what enforcement counts.
      sessions: countActiveAccountSessions(
        await store.listAccountSessions(account.id),
        await store.listNodes(account.id),
      ),
      // Hosted work-queue runs started this UTC month (one claimed item = one
      // run). Paired with entitlements.workQueueMonthlyLimit so the queue UI can
      // show "used / limit" and prompt an upgrade when a free account runs out.
      workQueueRunsThisMonth: (await workQueueAllowance(account.id)).used,
    },
  });
}));

// --- Node registry ------------------------------------------------------

// A signed-in user enrolls a node (by its self-generated nodeId). Returns an
// enrollment token the node stores and uses to authenticate to the relay /
// control plane. Enforces the plan's maxNodes.
app.post("/nodes/enroll", requireUser, asyncHandler(async (req, res) => {
  const account = await syncStripeBillingForAccount((req as Request & { account: Account }).account);
  const nodeId = String(req.body?.nodeId ?? "").trim();
  if (!nodeId) return res.status(400).json({ error: "Missing nodeId" });
  const result = await store.enrollNode(account.id, nodeId, String(req.body?.name ?? "Node"));
  res.json({ ok: true, ...result });
}));

// Lists the caller's nodes. Accepts an account session (all nodes), a
// node-scoped link grant from a linking QR (only that one node), or a node's own
// enrollment token (its account's nodes — so `bivy nodes` on an installed node
// can enumerate siblings). A leaked QR therefore reveals just the node it was
// minted for, never the whole account.
async function listClientNodes(req: Request, res: Response) {
  const token = bearer(req);
  const client = await store.resolveClient(token);
  if (client) {
    const nodes = await store.listNodes(client.accountId);
    const scoped = client.nodeId ? nodes.filter((node) => node.id === client.nodeId) : nodes;
    return res.json(scoped.map(({ enrollmentTokenHash: _hash, ...node }) => node));
  }
  // Fall back to node-token auth: an enrolled node listing its account's nodes.
  const node = await store.nodeFromEnrollmentToken(token);
  if (node) {
    const nodes = await store.listNodes(node.accountId);
    return res.json(nodes.map(({ enrollmentTokenHash: _hash, ...n }) => n));
  }
  return res.status(401).json({ error: "Unauthorized" });
}

app.get("/nodes", asyncHandler(listClientNodes));
app.get("/api/nodes", asyncHandler(listClientNodes));

app.delete("/nodes/:id", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const removed = await store.removeNode(account.id, String(req.params.id));
  res.status(removed ? 200 : 404).json({ ok: removed });
}));

// Let an installed node deregister itself during `bivy uninstall` without
// needing a browser/user session. Local uninstall still works if this fails.
app.delete("/node", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const removed = await store.removeNode(node.accountId, node.id);
  res.status(removed ? 200 : 404).json({ ok: removed });
}));

// --- Node-authenticated endpoints --------------------------------------

// A node reads its own account's plan + entitlements + node count, so `bivy
// status` can show the plan and node usage without a browser sign-in. Returns
// only the caller's own routing/plan metadata, never another account's data.
app.get("/node/account", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const account = await store.getAccount(node.accountId);
  res.json({
    plan: account?.plan ?? "free",
    entitlements: await store.entitlements(node.accountId),
    counts: { nodes: (await store.listNodes(node.accountId)).length },
  });
}));

// The node calls this periodically (and the relay can mark offline on
// disconnect). Used for online/offline status in the registry UI.
app.post("/node/heartbeat", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  await store.setNodeOnline(node.id, true);
  res.json({ ok: true });
}));

app.post("/node/name", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const updated = await store.setNodeName(node.id, String(req.body?.name ?? ""));
  res.json({ ok: true, node: updated });
}));

// The node reads its owner's entitlements (plan, node limit, push/relay flags).
// Device and session caps have been removed, so this no longer gates session
// creation; the account-wide open-session count is still reported for display.
app.get("/node/entitlements", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const entitlements = await store.entitlements(node.accountId);
  const accountSessionCount = countActiveAccountSessions(
    await store.listAccountSessions(node.accountId),
    await store.listNodes(node.accountId),
  );
  res.json({ ...entitlements, accountSessionCount });
}));

// The node advertises its current session metadata (replace semantics). Titles
// arrive E2E-encrypted; the control plane stores them opaquely. This powers the
// cross-node unified session list without the control plane seeing content.
function sessionAdvertsFrom(raw: unknown) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((s: unknown): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
    .map((s: Record<string, unknown>) => ({
      sessionId: String(s.sessionId ?? s.id ?? ""),
      status: String(s.status ?? "idle"),
      source: s.source != null ? String(s.source) : undefined,
      titleEnc: s.titleEnc != null ? String(s.titleEnc) : undefined,
      branch: s.branch != null ? String(s.branch) : undefined,
      // Stage 2 routing metadata (see store.ts SessionIndexEntry). Node-only.
      agentServiceAddress: s.agentServiceAddress != null ? String(s.agentServiceAddress) : undefined,
    }))
    .filter((s: { sessionId: string }) => s.sessionId);
}

app.post("/node/sessions", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const sessions = sessionAdvertsFrom(req.body?.sessions);
  await store.replaceNodeSessions(node.accountId, node.id, sessions);
  res.json({ ok: true, count: sessions.length });
}));

// A node reads back its OWN session index rows, INCLUDING the node-only
// `agentServiceAddress` routing metadata (Stage 3 of docs/agent-node-decoupling.md).
// A restarting/replacement daemon calls this on boot to adopt its still-live
// remote sessions: for each row with an address it re-attaches to the agent
// service hosting the child rather than losing it. Unlike the client-facing
// `/sessions` (listClientSessions), the address is NOT stripped here — same trust
// class as `nodeId`, node↔node only. Account-scoped in the store so a node can
// only ever read rows it owns.
app.get("/node/sessions", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const sessions = await store.listNodeSessions(node.accountId, node.id);
  res.json({ sessions });
}));

app.post("/internal/nodes/:nodeId/capabilities", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  if (String(req.params.nodeId) !== node.id) return res.status(403).json({ error: "Forbidden" });
  // Accepted for forward compatibility; durable node capability storage is added
  // with the account/fleet metadata model. The control plane stores no secrets.
  res.json({ ok: true });
}));

app.put("/internal/nodes/:nodeId/sessions/:sessionId", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  if (String(req.params.nodeId) !== node.id) return res.status(403).json({ error: "Forbidden" });
  const advert = sessionAdvertsFrom([{ ...req.body, sessionId: req.params.sessionId }]);
  const existing = (await store.listAccountSessions(node.accountId))
    .filter((s) => s.nodeId === node.id && s.sessionId !== String(req.params.sessionId))
    .map(({ nodeId: _nodeId, updatedAt: _updatedAt, ...s }) => s);
  await store.replaceNodeSessions(node.accountId, node.id, [...existing, ...advert]);
  res.json({ ok: true, count: advert.length });
}));

app.post("/internal/nodes/:nodeId/sessions/:sessionId/events", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  if (String(req.params.nodeId) !== node.id) return res.status(403).json({ error: "Forbidden" });
  // Metadata/audit events are accepted but not yet durably stored; never accept
  // transcript/stdout content here.
  res.json({ ok: true });
}));

app.post("/internal/notifications/hints", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const kind = String(req.body?.kind || req.body?.type || "session");
  const sessionId = String(req.body?.sessionId || "");
  const title = String(req.body?.title || (kind === "approval_requested" ? "Approval needed" : kind === "session_done" ? "Session finished" : kind === "session_error" ? "Session hit an error" : kind === "question_asked" ? "Bivy needs your input" : kind === "terminal_bell" ? "Terminal bell" : "Bivy update"));
  const body = String(req.body?.body || (kind === "approval_requested" ? "A session wants to run something — tap to approve or deny." : kind === "session_done" ? "A session finished — tap to review the result." : kind === "session_error" ? "A session failed its last turn — tap to see what went wrong." : kind === "question_asked" ? "A session is asking a question — tap to answer." : kind === "terminal_bell" ? "A terminal rang the bell — it may be waiting for you." : "Open Bivy to continue."));
  // Deep link via the SPA session route (`/sessions/:id`) — the client router
  // matches that path — carrying the owning node as a query param so a click can
  // switch to it before opening. Without a session id we can only open the root.
  const url = sessionId ? `/sessions/${encodeURIComponent(sessionId)}?node=${encodeURIComponent(node.id)}` : "/";
  const result = await sendPushToAccount(node.accountId, { title, body, kind, nodeId: node.id, sessionId, url });
  res.json({ ok: true, ...result });
}));

// A client reads the merged session list across all of its nodes. A node-scoped
// link grant only sees that one node's sessions.
async function listClientSessions(req: Request, res: Response) {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const all = await store.listAccountSessions(client.accountId);
  const scoped = client.nodeId ? all.filter((s) => s.nodeId === client.nodeId) : all;
  // Strip the agent-service address: it is node↔node routing metadata (Stage 2),
  // never needed by — and not exposed to — clients.
  const forClient = scoped.map(({ agentServiceAddress: _addr, ...s }) => s);
  res.json({ sessions: forClient });
}

app.get("/sessions", asyncHandler(listClientSessions));
app.get("/api/sessions", asyncHandler(listClientSessions));

function pushSubscriptionEndpoint(subscription: unknown): string {
  return subscription && typeof subscription === "object" && typeof (subscription as { endpoint?: unknown }).endpoint === "string"
    ? (subscription as { endpoint: string }).endpoint
    : "";
}

async function sendPushToAccount(accountId: string, payload: Record<string, unknown>) {
  if (!webPushEnabled) return { enabled: false, sent: 0 };
  // Authoritative plan gate on the delivery path — when entitlements are enforced
  // (Bivy Cloud), subscriptions created while paid must stop firing the moment an
  // account downgrades, without depending on subscription cleanup. `subscribe` is
  // also gated, but this is the source of truth so a lingering subscription never
  // leaks push to a free account. When enforcement is off (self-host) this is a
  // no-op and every account may receive push.
  if (!(await accountPushAllowed(accountId))) return { enabled: false, sent: 0, reason: "plan" };
  // Per-account, per-kind opt-out. The `kind` string arrives from the node's
  // notification hint and flows unchanged to the browser; muting it here stops
  // delivery for every device on the account without touching subscriptions.
  const kind = String(payload.kind || "");
  if (kind) {
    const prefs = await store.getNotificationPreferences(accountId);
    if ((prefs as Record<string, boolean>)[kind] === false) return { enabled: true, sent: 0, reason: "muted" };
  }
  let sent = 0;
  for (const sub of await store.listPushSubscriptions(accountId)) {
    try {
      await webpush.sendNotification(sub.subscription as webpush.PushSubscription, JSON.stringify(payload));
      sent += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) await store.removePushSubscription(accountId, sub.endpoint);
      else console.warn("[web-push] send failed", error);
    }
  }
  return { enabled: true, sent };
}

app.get("/api/push/vapid-public-key", (_req, res) => {
  res.json({ enabled: webPushEnabled, publicKey: webPushEnabled ? vapidPublicKey : "" });
});

app.post("/api/push/subscribe", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  if (!(await accountPushAllowed(client.accountId))) return res.status(402).json({ error: "Push notifications require the Individual or Team plan." });
  const subscription = req.body?.subscription ?? req.body;
  const endpoint = pushSubscriptionEndpoint(subscription);
  if (!endpoint) return res.status(400).json({ error: "Missing push subscription endpoint" });
  await store.upsertPushSubscription(client.accountId, endpoint, subscription);
  res.json({ ok: true, enabled: webPushEnabled });
}));

app.delete("/api/push/subscribe", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const endpoint = String(req.body?.endpoint ?? "");
  if (endpoint) await store.removePushSubscription(client.accountId, endpoint);
  res.json({ ok: true });
}));

// Per-account notification preferences: which push kinds are enabled. Account-
// scoped so the choice syncs across all of a user's devices; enforced in
// `sendPushToAccount`.
app.get("/api/push/preferences", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const preferences = await store.getNotificationPreferences(client.accountId);
  res.json({ preferences });
}));

app.put("/api/push/preferences", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Accept only known kinds with boolean values; silently ignore anything else.
  const patch: Partial<Record<NotificationKind, boolean>> = {};
  for (const kind of NOTIFICATION_KINDS) {
    if (typeof body[kind] === "boolean") patch[kind] = body[kind] as boolean;
  }
  const preferences = await store.setNotificationPreferences(client.accountId, patch);
  res.json({ preferences });
}));

// Ephemeral provisioning cold-start relay. When a signed-in device has no node
// online to broker for it, it can ask the control plane to forward ONE
// allowlisted provider request (Fly/Hetzner/AWS/...) so it can create/destroy
// a machine from just a phone. The token/credentials ride in the request and
// are used transiently — NEVER stored or logged here. The host allowlist is
// the SSRF guard; this is a deliberately narrow, non-storing exception to
// "the control plane holds no secrets" (the secret is only in-flight, for the
// user's own cloud account). Must be kept in lock-step with the two other
// copies: `ALLOWED_HOSTS` in packages/core/src/ephemeral.ts (browser adapter)
// and `EPHEMERAL_ALLOWED_HOSTS` in src/ephemeral-exec.ts (node broker).
const EPHEMERAL_ALLOWED_HOSTS = new Set([
  "api.hetzner.cloud",
  "api.machines.dev",
  "api.fly.io",
  "ec2.us-east-1.amazonaws.com",
  "ec2.us-west-2.amazonaws.com",
  "ec2.eu-west-1.amazonaws.com",
  "ec2.eu-central-1.amazonaws.com",
  "ec2.ap-southeast-1.amazonaws.com",
  "ec2.ap-northeast-1.amazonaws.com",
  "ssm.us-east-1.amazonaws.com",
  "ssm.us-west-2.amazonaws.com",
  "ssm.eu-west-1.amazonaws.com",
  "ssm.eu-central-1.amazonaws.com",
  "ssm.ap-southeast-1.amazonaws.com",
  "ssm.ap-northeast-1.amazonaws.com",
]);
app.post("/api/ephemeral/exec", requireUser, asyncHandler(async (req, res) => {
  // Quick ephemeral servers are a paid feature. The persistent installer stays
  // free; this cold-start relay (spin a cloud box up from just a phone) is gated
  // to Pro/Team when entitlements are enforced (Bivy Cloud). Mirrors the client
  // gate in EphemeralSheet — this is the authoritative check.
  const account = (req as Request & { account: Account }).account;
  if (enforceEntitlements && !(await store.entitlements(account.id)).ephemeralEnabled) {
    return res.status(403).json({ error: "Quick ephemeral servers are a Pro feature. Upgrade to launch cloud runners." });
  }
  const url = String(req.body?.url ?? "");
  let host: string;
  try { host = new URL(url).host; } catch { return res.status(400).json({ error: `Bad provider URL` }); }
  if (!EPHEMERAL_ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: `Refusing to proxy to non-provider host: ${host}` });
  const method = String(req.body?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(req.body?.headers ?? {}) };
  let payload: string | undefined;
  if (req.body?.body !== undefined && req.body?.body !== null && method !== "GET" && method !== "HEAD") {
    payload = typeof req.body.body === "string" ? req.body.body : JSON.stringify(req.body.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const upstream = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    const text = await upstream.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    res.json({ status: upstream.status, body });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timeout);
  }
}));

// E2E model-provider auth vault. The control plane stores only ciphertext and
// per-node wrapped vault keys; API keys/OAuth records are encrypted/decrypted on
// enrolled nodes with a vault key the control plane never sees.
app.get("/node/model-auth-vault", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  res.json({
    ok: true,
    vault: await store.getModelAuthVault(node.accountId) ?? null,
    wrappedKey: await store.getModelAuthWrappedKey(node.accountId, node.id) ?? null,
    requests: await store.listModelAuthKeyRequests(node.accountId, node.id),
  });
}));

app.put("/node/model-auth-vault", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const ciphertext = String(req.body?.ciphertext ?? "").trim();
  if (!ciphertext) return res.status(400).json({ error: "Missing ciphertext" });
  const vault = await store.setModelAuthVault(node.accountId, node.id, ciphertext);
  res.json({ ok: true, vault });
}));

app.post("/node/model-auth-key/public", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const publicKey = String(req.body?.publicKey ?? "").trim();
  if (!publicKey) return res.status(400).json({ error: "Missing publicKey" });
  await store.setModelAuthNodePublicKey(node.accountId, node.id, publicKey);
  res.json({ ok: true });
}));

app.post("/node/model-auth-key/request", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const publicKey = String(req.body?.publicKey ?? "").trim();
  if (!publicKey) return res.status(400).json({ error: "Missing publicKey" });
  await store.requestModelAuthWrappedKey(node.accountId, node.id, publicKey);
  res.json({ ok: true });
}));

app.put("/node/model-auth-key/wrapped", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const targetNodeId = String(req.body?.targetNodeId ?? "").trim();
  const wrappedKey = String(req.body?.wrappedKey ?? "").trim();
  const wrappedByPublicKey = String(req.body?.wrappedByPublicKey ?? "").trim();
  if (!targetNodeId || !wrappedKey || !wrappedByPublicKey) return res.status(400).json({ error: "Missing targetNodeId, wrappedByPublicKey, or wrappedKey" });
  const rec = await store.setModelAuthWrappedKey(node.accountId, targetNodeId, node.id, wrappedByPublicKey, wrappedKey);
  res.json({ ok: true, wrappedKey: rec });
}));

// --- Work queue (E2 GitHub webhook sink, E4 Slack) ----------------------
// Inbound front doors enqueue WorkItems; the node (outbound-only) pulls them.
// The control plane only routes metadata — the node runs the work with its own
// token, so issue/agent content never reaches us.

// Register (or rotate) an inbound hook for the signed-in account. Returns the
// webhook URL + secret to paste into GitHub ("Payload URL" + "Secret") or Slack.
app.post("/account/hooks", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const kind = String(req.body?.kind ?? "github").trim().toLowerCase();
  if (kind !== "github" && kind !== "github_app" && kind !== "slack") return res.status(400).json({ error: "kind must be 'github', 'github_app', or 'slack'" });
  const hook = await store.createInboundHook(account.id, kind);
  const url = `${baseUrl(req)}/webhooks/${kind}/${hook.id}`;
  res.json({ ok: true, id: hook.id, kind, secret: hook.secret, url });
}));

// Node-side setup helper. The CLI only has a node enrollment token after
// `bivy relay:setup`; let that node create an account-scoped inbound hook so
// GitHub issue setup can be completed from the machine that will run the work,
// without requiring a separate browser/user bearer token in the CLI.
app.post("/node/hooks", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const kind = String(req.body?.kind ?? "github").trim().toLowerCase();
  if (kind !== "github" && kind !== "github_app" && kind !== "slack") return res.status(400).json({ error: "kind must be 'github', 'github_app', or 'slack'" });
  const hook = await store.createInboundHook(node.accountId, kind);
  const url = `${baseUrl(req)}/webhooks/${kind}/${hook.id}`;
  res.json({ ok: true, id: hook.id, kind, secret: hook.secret, url });
}));

// Adopt the account's EXISTING github_app hook (id + url + secret), so a node can
// connect to an already-set-up GitHub App without minting a new hook — the app's
// existing webhook (URL + secret) keeps working, no reconfiguration. Returns 404
// when the account has no github_app hook yet (caller then creates one).
app.get("/node/hooks/github_app", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  // An account may have several apps (personal + one per org), each with its own
  // hook and its own webhook secret. Ask by app id so a node reconnecting app B
  // can't adopt app A's hook and start verifying deliveries with the wrong secret.
  const appId = typeof req.query.appId === "string" ? req.query.appId.trim() : "";
  const hook = await store.getGithubAppHook(node.accountId, appId || undefined);
  if (!hook) return res.status(404).json({ error: "No GitHub App hook for this account" });
  const url = `${baseUrl(req)}/webhooks/github_app/${hook.id}`;
  res.json({ ok: true, id: hook.id, secret: hook.secret, url, appId: hook.appId });
}));

// Adopt an externally-generated secret for a hook (GitHub App manifest returns
// the webhook secret at creation time, so the node registers it here).
app.post("/node/hooks/:id/secret", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const secret = String(req.body?.secret ?? "").trim();
  if (!secret) return res.status(400).json({ error: "Missing secret" });
  const hook = await store.setInboundHookSecret(node.accountId, String(req.params.id), secret);
  if (!hook) return res.status(404).json({ error: "Unknown hook" });
  res.json({ ok: true, id: hook.id });
}));

// Register a GitHub App hook's display/routing metadata. The node sends the
// app's slug (→ the unique `@`-mention handle) and name at connect time; the
// private key stays on the node.
app.post("/node/hooks/:id/app-meta", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const mention = typeof req.body?.mention === "string" ? req.body.mention : undefined;
  const name = typeof req.body?.name === "string" ? req.body.name : undefined;
  const appId = typeof req.body?.appId === "string" ? req.body.appId : undefined;
  const hook = await store.setInboundHookAppMeta(node.accountId, String(req.params.id), { mention, name, appId });
  if (!hook) return res.status(404).json({ error: "Unknown hook" });
  // This node holds the key and is servicing the app — record it so the UI can
  // tell "configured" from "actually being served".
  await store.setInboundHookServingNode(node.accountId, hook.id, node.id);
  res.json({ ok: true, id: hook.id, mention: hook.botMention, name: hook.appName });
}));

// Register app metadata WITHOUT knowing the hook id — the node calls this on
// startup to backfill the slug/name for an app it connected before this existed
// (so existing installs self-heal: the mention handle routes and the UI shows
// the real name without reconnecting). Resolves the account's github_app hook.
app.post("/node/github-app/meta", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const mention = typeof req.body?.mention === "string" ? req.body.mention : undefined;
  const name = typeof req.body?.name === "string" ? req.body.name : undefined;
  const appId = typeof req.body?.appId === "string" ? req.body.appId : undefined;
  const owner = typeof req.body?.owner === "string" ? req.body.owner : undefined;
  const ownerType = typeof req.body?.ownerType === "string" ? req.body.ownerType : undefined;
  // Match the hook for THIS app. Without the app id we'd stamp one app's slug
  // onto another app's hook, and mentions would route to the wrong place.
  const hook =
    (appId ? await store.getGithubAppHook(node.accountId, appId) : undefined) ??
    // An app connected before it had metadata has a hook with no app_id yet;
    // fall back to the account's primary hook so those self-heal.
    (await store.listGithubAppHooks(node.accountId)).find((h) => !h.appId) ??
    (appId ? undefined : await store.getGithubAppHook(node.accountId));
  if (!hook) return res.json({ ok: false, reason: "no-github-app-hook" });
  const updated = await store.setInboundHookAppMeta(node.accountId, hook.id, { mention, name, appId, owner, ownerType });
  // The node that backfills app-meta is the one holding the key → mark it serving.
  await store.setInboundHookServingNode(node.accountId, hook.id, node.id);
  res.json({ ok: true, mention: updated?.botMention, name: updated?.appName });
}));

// The node reports how many repos/orgs its GitHub App is installed on. Only the
// node can know this (it holds the app key and queries GitHub's /app/installations),
// so it pushes the count here; the control plane serves it back via
// /account/github-app to warn when the app is installed on nothing.
app.post("/node/github-app/installations", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const count = Number(req.body?.count);
  if (!Number.isFinite(count) || count < 0) return res.status(400).json({ error: "Missing or invalid count" });
  const appId = typeof req.body?.appId === "string" ? req.body.appId.trim() : "";
  const hook = await store.getGithubAppHook(node.accountId, appId || undefined);
  if (!hook) return res.json({ ok: false, reason: "no-github-app-hook" });
  const updated = await store.setInboundHookInstallStatus(node.accountId, hook.id, count);
  res.json({ ok: true, installCount: updated?.installCount });
}));

// The signed-in account's connected GitHub App (name + mention handle), for the
// settings UI. Returns { connected: false } when no app is set up.
app.get("/account/github-app", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const hooks = await store.listGithubAppHooks(client.accountId);
  if (!hooks.length) return res.json({ connected: false, apps: [] });
  // Which node holds each app's key and is servicing it. The control plane can't
  // run an app itself, so "connected" (a hook exists) is not the same as "a live
  // node is serving it" — a deleted/reinstalled node clears servingNodeId.
  const nodes = await store.listNodes(client.accountId);
  const describe = (hook: (typeof hooks)[number]) => {
    const slug = hook.botMention || "";
    const servingNode = hook.servingNodeId ? nodes.find((n) => n.id === hook.servingNodeId) : undefined;
    const servedBy = servingNode
      ? { id: servingNode.id, name: servingNode.name, online: Boolean(servingNode.online), lastSeenAt: servingNode.lastSeenAt }
      : null;
    return {
      connected: true,
      name: hook.appName || slug || "GitHub App",
      slug,
      mention: slug,
      editUrl: slug ? `https://github.com/settings/apps/${encodeURIComponent(slug)}` : "https://github.com/settings/apps",
      // Numeric App ID (display/pre-fill only), and the key the UI addresses an
      // individual app by for disconnect / default-node.
      appId: hook.appId,
      hookId: hook.id,
      // Which GitHub account this app covers — with several connected, this is
      // what distinguishes "my personal app" from "the acme org app".
      owner: hook.appOwner,
      ownerType: hook.appOwnerType,
      // The app delivers no events until it's installed on at least one repo, so
      // the connected UI links here to add/manage repositories.
      installUrl: slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : "https://github.com/settings/installations",
      // Install status the node last reported (it holds the key). undefined =
      // never synced (node offline / pre-feature); `installed:false` = a positive
      // "installed on zero repos" signal the UI can warn on.
      installCount: hook.installCount,
      installed: typeof hook.installCount === "number" ? hook.installCount > 0 : undefined,
      // The node-label suffix (e.g. "macbook") that untagged/generic `bivy`-routed
      // work defaults to. undefined = no default (shared-queue behavior).
      defaultNode: hook.defaultNode,
      // The node currently servicing the app (holds the key), or null if none — the
      // signal that lets the UI say "no node is running this app; connect one".
      servedBy,
      servingNodeSeenAt: hook.servingNodeSeenAt,
    };
  };
  const apps = hooks.map(describe);
  // Flat top-level fields describe the first app, so clients written against the
  // single-app shape keep working against a multi-app account.
  res.json({ ...apps[0], apps });
}));

// Set (or clear) the account's default node: untagged issues/comments that
// would otherwise route to the shared `bivy` queue instead route to
// `bivy/<defaultNode>`. Settings → GitHub App in the web UI.
app.post("/account/github-app/default-node", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const appId = typeof req.body?.appId === "string" ? req.body.appId.trim() : "";
  // The default node is an account-level preference stored per hook. Without an
  // app id, set it on every app so the account has one answer rather than N.
  const hooks = appId
    ? [await store.getGithubAppHook(client.accountId, appId)].filter(Boolean as unknown as (h: unknown) => boolean)
    : await store.listGithubAppHooks(client.accountId);
  const targets = hooks as Array<{ id: string }>;
  if (!targets.length) return res.status(404).json({ error: "No GitHub App connected" });
  const node = typeof req.body?.node === "string" ? req.body.node.trim() : "";
  let updated: { defaultNode?: string } | undefined;
  for (const target of targets) {
    updated = (await store.setInboundHookDefaultNode(client.accountId, target.id, node || undefined)) ?? updated;
  }
  // Re-route work already waiting on the shared/default queue to the new default,
  // so changing the default node also moves pending items (not just future ones).
  const rerouted = await store.rerouteDefaultRoutedPending(client.accountId, applyDefaultNode("bivy", updated?.defaultNode));
  for (const item of rerouted) void notifyRelaysWorkAvailable(client.accountId, item);
  res.json({ ok: true, defaultNode: updated?.defaultNode, rerouted: rerouted.length });
}));

// Disconnect the account's GitHub App: drop the inbound hook so it stops routing
// and the UI no longer shows it as connected. The node clears its own copy of the
// key separately (github.app.disconnect). Idempotent — ok if nothing is connected.
app.delete("/account/github-app", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  // With an app id, disconnect just that app and leave the account's others
  // alone. Without one, remove ALL github_app hooks — abandoned create flows
  // leave orphans, and deleting only the newest would let one resurface as
  // "connected".
  const appId = typeof req.query.appId === "string" ? req.query.appId.trim() : "";
  const removed = appId
    ? await store.deleteGithubAppHooksForApp(client.accountId, appId)
    : await store.deleteGithubAppHooks(client.accountId);
  res.json({ ok: true, removed });
}));

// Recent incoming work items for the account, for the queue UI. Each carries a
// status (pending → not picked up yet; claimed → a node is running it; done).
app.get("/account/work-items", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
  const items = await store.listWorkItems(client.accountId, limit);
  // Titles can carry issue text; keep the payload lean and non-sensitive.
  res.json(items.map((w) => ({
    id: w.id,
    source: w.source,
    status: w.status,
    label: w.label,
    title: w.title,
    repo: w.repo,
    issueNumber: w.issueNumber,
    url: w.url,
    runtimeId: w.runtimeId,
    model: w.model,
    ephemeral: w.ephemeral,
    createdAt: w.createdAt,
    claimedAt: w.claimedAt,
    claimedByNodeId: w.claimedByNodeId,
    completedAt: w.completedAt,
  })));
}));

// Manually dispatch a *pending* queue item to a chosen node + agent (the queue
// "Run…" action) — or, when `ephemeral: true`, to a device-provisioned ephemeral
// server (issue #532). Either way `node` is just a routing-label suffix: for a
// persistent node it's the node's own name; for an ephemeral server it's
// `ephemeralNodeLabel(machine.nodeId)`, computed by the calling device right after
// provisioning (before the machine has even booted) so the item can be assigned to
// it immediately. Re-routes the existing item (label `bivy/<node>`, or the shared
// `bivy` when no node is given) and records an optional agent/model override, then
// nudges the target node's relay so it picks the item up promptly.
app.post("/account/work-items/:id/assign", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  if (!(await store.entitlements(client.accountId)).workQueueEnabled) {
    return res.status(403).json({ error: "The work queue is a paid feature." });
  }
  const node = typeof req.body?.node === "string" ? req.body.node.trim() : "";
  const runtimeId = typeof req.body?.runtimeId === "string" ? req.body.runtimeId.trim() : "";
  const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  const ephemeral = Boolean(req.body?.ephemeral);
  const label = node ? `bivy/${node}` : "bivy";
  const item = await store.assignWorkItem(client.accountId, String(req.params.id), {
    label,
    runtimeId: runtimeId || undefined,
    model: model || undefined,
    ephemeral,
  });
  if (!item) return res.status(404).json({ error: "No pending work item with that id" });
  void notifyRelaysWorkAvailable(client.accountId, item);
  res.json({ ok: true, id: item.id, label: item.label, runtimeId: item.runtimeId, model: item.model, ephemeral: item.ephemeral });
}));

// The account's ephemeral-queue-default preference (issue #532): whether a
// signed-in device should auto-provision an ephemeral runner for this queue when
// nothing persistent is online, and which saved provider/region/size/ttl to use.
// Non-secret preferences only — the provider TOKEN that would actually act on this
// stays device-local (see packages/core/src/ephemeral.ts's EphemeralKeyStore); the
// control plane only remembers the choice so it's consistent across the account's
// devices, the same way `/account/github-app/default-node` remembers a routing
// choice without being able to act on it itself.
app.get("/account/ephemeral-default", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  res.json(await store.getEphemeralQueueDefault(client.accountId));
}));

app.put("/account/ephemeral-default", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<EphemeralQueueDefault> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.provider === "string") patch.provider = body.provider.trim() || undefined;
  if (typeof body.region === "string") patch.region = body.region.trim() || undefined;
  if (typeof body.size === "string") patch.size = body.size.trim() || undefined;
  if (typeof body.ttlMinutes === "number") patch.ttlMinutes = body.ttlMinutes;
  res.json(await store.setEphemeralQueueDefault(client.accountId, patch));
}));

// Clear the whole queue: remove every *pending* item (the "Clear queue" action).
// Registered before the :id route so "clear" can't be read as an item id.
app.delete("/account/work-items", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const removed = await store.clearPendingWorkItems(client.accountId);
  res.json({ ok: true, removed });
}));

// Remove a single item from the queue (the "×" on a row).
app.delete("/account/work-items/:id", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const removed = await store.deleteWorkItem(client.accountId, String(req.params.id));
  if (!removed) return res.status(404).json({ error: "No work item with that id" });
  res.json({ ok: true });
}));

// GitHub `issues` / `issue_comment` webhook. Verifies the per-hook HMAC, and
// enqueues a work item routed to a `bivy` / `bivy/<node>` label (or a bot
// mention). Both `/webhooks/github/:id` (classic hooks) and
// `/webhooks/github_app/:id` (GitHub App hooks) are accepted: the hook URL is
// minted as `/webhooks/${kind}/${id}`, so an app hook's baked-in webhook URL is
// `/webhooks/github_app/<id>`. Registering only the `github` path made every
// GitHub App delivery hit a non-existent route and 404 before reaching this
// handler — so no app-driven issue/comment ever enqueued.
app.post(["/webhooks/github/:id", "/webhooks/github_app/:id"], asyncHandler(async (req, res) => {
  const hook = await store.getInboundHook(String(req.params.id));
  if (!hook || (hook.kind !== "github" && hook.kind !== "github_app")) return res.status(404).json({ error: "Unknown hook" });
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verifyGithubSignature(hook.secret, raw, req.headers["x-hub-signature-256"] as string | undefined)) {
    return res.status(401).json({ error: "Bad signature" });
  }
  const event = String(req.headers["x-github-event"] ?? "");
  if (event === "ping") return res.json({ ok: true, pong: true });
  // Plan gate: the hosted work queue is on every plan (free is metered per run at
  // claim time, see workQueueAllowance), so this only refuses a plan that has the
  // feature fully off. Ack with 200 so GitHub marks the delivery successful (a
  // non-2xx would make GitHub retry forever) but enqueue nothing in that case.
  if (!(await store.entitlements(hook.accountId)).workQueueEnabled) {
    return res.json({ ok: true, enqueued: false, reason: "plan" });
  }
  // GitHub reuses the delivery GUID on redelivery, so it's a natural idempotency
  // key: a redelivered webhook returns the existing item instead of duplicating.
  const deliveryId = String(req.headers["x-github-delivery"] ?? "");
  const dedupeKey = deliveryId ? `gh:${deliveryId}` : undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  // For a GitHub App, the payload names the installation the node mints a token
  // for. Classic per-repo webhooks have none (the node uses its PAT).
  const installationId = parseInstallationId(payload);

  // issue_comment: an `@`-mention of the bot handle turns the comment into work
  // routed to a node (the comment text is the instruction the node acts on).
  if (event === "issue_comment") {
    // Prefer the per-account handle the node registered (the app's unique slug),
    // so it can't collide with an unrelated real GitHub user. Fall back to the
    // global env default only for legacy hooks that never registered one.
    const triggerLogin = (hook.botMention || process.env.BIVY_GITHUB_BOT_MENTION || "bivy").trim();
    const comment = parseGithubCommentEvent(payload, triggerLogin);
    if (!comment) return res.json({ ok: true, enqueued: false });
    const rawLabel = pickCommentRoutingLabel(comment.instruction, comment.issueLabels, triggerLogin);
    const label = applyDefaultNode(rawLabel, hook.defaultNode);
    const item = await store.enqueueWorkItem(hook.accountId, {
      label,
      source: "github:comment",
      title: comment.title,
      body: comment.instruction,
      repo: comment.repo,
      issueNumber: comment.issueNumber,
      url: comment.url,
      dedupeKey,
      // Landed on the shared queue with no explicit target → re-routable when the
      // account's default node changes.
      defaultRouted: rawLabel === "bivy",
      installationId,
      appId: hook.appId,
    });
    void notifyRelaysWorkAvailable(hook.accountId, item);
    return res.json({ ok: true, enqueued: true, id: item.id, label });
  }

  // issues: a `bivy` / `bivy/<node>` label OR an `@`-mention of the bot handle
  // in the issue description routes the issue to a node. The body mention lets an
  // issue trigger the moment it's opened, without needing a separate comment.
  const issue = parseGithubIssueEvent(payload);
  const triggerLogin = (hook.botMention || process.env.BIVY_GITHUB_BOT_MENTION || "bivy").trim();
  const rawLabel = issue ? pickIssueRoutingLabel(issue, triggerLogin) : undefined;
  const label = rawLabel ? applyDefaultNode(rawLabel, hook.defaultNode) : undefined;
  if (!issue || !label || !rawLabel) return res.json({ ok: true, enqueued: false });
  const item = await store.enqueueWorkItem(hook.accountId, {
    label,
    source: "github:issue",
    title: issue.title,
    body: issue.body,
    repo: issue.repo,
    issueNumber: issue.issueNumber,
    url: issue.url,
    dedupeKey,
    // One issue emits several deliveries (opened, labeled, edited). Collapse them
    // into a single pending item so labelling *and* @-mentioning an issue doesn't
    // queue it two or three times.
    collapseKey: `gh-issue:${issue.repo}#${issue.issueNumber}`,
    defaultRouted: rawLabel === "bivy",
    installationId,
    appId: hook.appId,
  });
  void notifyRelaysWorkAvailable(hook.accountId, item);
  res.json({ ok: true, enqueued: true, id: item.id, label });
}));

// Slack slash command (`/bivy on <node> <prompt>`). Verifies the Slack signing
// secret stored as the hook secret, then enqueues a prompt work item.
app.post("/webhooks/slack/:id", asyncHandler(async (req, res) => {
  const hook = await store.getInboundHook(String(req.params.id));
  if (!hook || hook.kind !== "slack") return res.status(404).json({ error: "Unknown hook" });
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const ok = verifySlackSignature(
    hook.secret,
    req.headers["x-slack-request-timestamp"] as string | undefined,
    raw,
    req.headers["x-slack-signature"] as string | undefined,
  );
  if (!ok) return res.status(401).json({ error: "Bad signature" });
  if (!(await store.entitlements(hook.accountId)).workQueueEnabled) {
    return res.json({ response_type: "ephemeral", text: "The Bivy work queue is a paid feature. Upgrade to the Individual or Team plan to route Slack commands to your nodes." });
  }
  const form = new URLSearchParams(raw.toString("utf8"));
  const { node, prompt } = parseSlackCommand(form.get("text") ?? "");
  if (!prompt) return res.json({ response_type: "ephemeral", text: "Usage: /bivy [on <node>] <what to do>" });
  const label = node ? `bivy/${node}` : "bivy";
  const item = await store.enqueueWorkItem(hook.accountId, { label, source: "slack", title: prompt });
  void notifyRelaysWorkAvailable(hook.accountId, item);
  res.json({ response_type: "ephemeral", text: `On it — queued for ${label}. I'll open a PR when it's done.` });
}));

// A node pulls its pending work. `labels` (comma-separated) is the set it serves
// — typically its own `bivy/<node>` plus the shared `bivy`.
app.get("/node/work", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const labels = String(req.query.labels ?? "bivy")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const items = await store.listPendingWorkItems(node.accountId, labels.length ? labels : ["bivy"]);
  // Free-tier monthly quota: once this month's run allowance is spent, hide
  // pending items so the node stops trying to claim them. They stay queued and
  // become visible again when the month rolls over (no data lost, no churn). The
  // claim endpoint below is the authoritative backstop for a direct/racing claim.
  if ((await workQueueAllowance(node.accountId)).exhausted) return res.json({ items: [] });
  res.json({ items });
}));

// Claim one item (atomic; only one node wins). Returns the item or 409 if taken.
app.post("/node/work/:id/claim", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  // Authoritative free-tier quota gate: one claimed item = one run. 402 (not 409)
  // so the node can tell "you're out of runs this month" from "someone else won
  // this item". Only bites under ENFORCE_ENTITLEMENTS; self-host is unlimited.
  const allowance = await workQueueAllowance(node.accountId);
  if (allowance.exhausted) {
    return res.status(402).json({ error: "Monthly work-queue run limit reached for your plan.", reason: "quota", limit: allowance.limit, used: allowance.used });
  }
  const item = await store.claimWorkItem(node.accountId, node.id, String(req.params.id));
  if (!item) return res.status(409).json({ error: "Already claimed or unknown" });
  res.json({ ok: true, item });
}));

app.post("/node/work/:id/complete", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  await store.completeWorkItem(node.accountId, String(req.params.id));
  res.json({ ok: true });
}));

// The node mints a short-lived, node-scoped client grant to link a remote
// device. Returned to the node UI, which packages it into a linking QR.
app.post("/node/link-grant", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  // Node-scoped, expiring grant (least privilege): the QR can only reach the
  // node it was minted for, and only until it expires. The relay enforces the
  // node scope (introspect/session returns nodeId). A leaked QR therefore
  // cannot reach the account's other nodes, and stops working after the TTL.
  const sessionToken = await store.createLinkGrant(node.accountId, node.id, LINK_GRANT_TTL_MS);
  res.json({ ok: true, sessionToken, nodeId: node.id, nodeName: node.name, relayUrl: relayUrlForNode(node.id) });
}));

// Session replication (docs/session-replication.md) --------------------------
//
// A node mints a client-scoped grant for a SIBLING node it co-owns, so an owner
// daemon can connect to its standby as a relay client (the only way to reach a
// node over the relay). This closes the "credential gap": an enrollment token
// can enumerate siblings but couldn't otherwise mint a client credential. The
// grant is node-scoped to the sibling and expiring — least privilege.
app.post("/node/sibling-link-grant", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const siblingId = String(req.body?.nodeId ?? "").trim();
  if (!siblingId) return res.status(400).json({ error: "Missing nodeId" });
  if (siblingId === node.id) return res.status(400).json({ error: "A node cannot replicate to itself" });
  const owns = (await store.listNodes(node.accountId)).some((n) => n.id === siblingId);
  if (!owns) return res.status(404).json({ error: "Unknown sibling node" });
  const grant = await store.createLinkGrant(node.accountId, siblingId, LINK_GRANT_TTL_MS);
  res.json({ ok: true, grant, nodeId: siblingId, relayUrl: relayUrlForNode(siblingId) });
}));

// The current owner declares (or clears) the standby for a session it owns.
app.post("/node/sessions/:sessionId/standby", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  const standbyNodeId = req.body?.standbyNodeId ? String(req.body.standbyNodeId).trim() : undefined;
  if (standbyNodeId) {
    const owns = (await store.listNodes(node.accountId)).some((n) => n.id === standbyNodeId);
    if (!owns) return res.status(404).json({ error: "Unknown standby node" });
    if (standbyNodeId === node.id) return res.status(400).json({ error: "A node cannot be its own standby" });
  }
  const ownership = await store.setSessionStandby(node.accountId, sessionId, node.id, standbyNodeId);
  res.json({ ok: true, ownership });
}));

// Read a session's ownership/epoch (owner needs its epoch to stamp frames; the
// standby reads it to promote with the right expectedEpoch).
app.get("/node/sessions/:sessionId/ownership", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const sessionId = String(req.params.sessionId ?? "").trim();
  const ownership = await store.getSessionOwnership(node.accountId, sessionId);
  res.json({ ok: true, ownership: ownership ?? null });
}));

// Promote a node to owner via compare-and-set on the epoch. Authorized to the
// designated standby taking over (toNodeId === caller) or the current owner
// handing off. A stale expectedEpoch loses the race → 409 (the fence).
app.post("/node/sessions/:sessionId/promote", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const sessionId = String(req.params.sessionId ?? "").trim();
  const toNodeId = String(req.body?.toNodeId ?? "").trim();
  const expectedEpoch = Number(req.body?.expectedEpoch);
  if (!sessionId || !toNodeId || !Number.isInteger(expectedEpoch)) {
    return res.status(400).json({ error: "Missing sessionId, toNodeId, or expectedEpoch" });
  }
  const current = await store.getSessionOwnership(node.accountId, sessionId);
  if (!current) return res.status(404).json({ error: "Session is not replicated" });
  // Only the current owner (handoff) or the node being promoted may promote.
  if (node.id !== current.ownerNodeId && node.id !== toNodeId) {
    return res.status(403).json({ error: "Not authorized to promote this session" });
  }
  const owns = (await store.listNodes(node.accountId)).some((n) => n.id === toNodeId);
  if (!owns) return res.status(404).json({ error: "Unknown target node" });
  const promoted = await store.promoteSession(node.accountId, sessionId, toNodeId, expectedEpoch);
  if (!promoted) return res.status(409).json({ error: "Epoch mismatch — promotion lost the race", current });
  res.json({ ok: true, ownership: promoted });
}));

// A node or client exchanges its long-lived bearer (over TLS, directly to the
// control plane) for a short-lived, single-use relay ticket. Only the ticket is
// ever handed to the relay, so a compromised relay never learns a reusable
// credential.
app.post("/node/relay-ticket", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  try {
    const ticket = await store.createRelayTicket({ role: "node", accountId: node.accountId, nodeId: node.id });
    relayTicketMetrics.nodeMinted += 1;
    res.json({ ok: true, ticket, relayUrl: relayUrlForNode(node.id) });
  } catch (error) {
    relayTicketMetrics.nodeFailed += 1;
    console.error(`[relay-ticket] failed to mint node ticket nodeId=${node.id} accountId=${node.accountId}:`, error);
    throw error;
  }
}));

// A signed-in browser/app mints a short-lived, node-scoped pairing grant. The
// client sends this grant to the node over the relay for account-based pairing,
// so the relay never sees the user's long-lived account session token.
app.post("/client/pair-grant", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const nodeId = String(req.body?.nodeId ?? "").trim();
  if (!nodeId) return res.status(400).json({ error: "Missing nodeId" });
  const ownsNode = (await store.listNodes(account.id)).some((node) => node.id === nodeId);
  if (!ownsNode) return res.status(404).json({ error: "Unknown node" });
  const grant = await store.createLinkGrant(account.id, nodeId, 2 * 60_000);
  res.json({ ok: true, grant, nodeId, relayUrl: relayUrlForNode(nodeId) });
}));

// A signed-in app mints a DURABLE, node-scoped grant to keep as a linked node's
// saved bearer. Unlike the pairing grant above, this one is never sent over the
// relay — it's used only over TLS to mint per-connect relay tickets — so it can
// live as long as the QR link grant. This lets an account-linked node keep
// working after the user signs out of their account (sign-out revokes only the
// account session, not separately-minted node grants). Account ownership of the
// node is required, so a client can only mint grants for its own nodes.
app.post("/client/link-grant", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const nodeId = String(req.body?.nodeId ?? "").trim();
  if (!nodeId) return res.status(400).json({ error: "Missing nodeId" });
  const ownsNode = (await store.listNodes(account.id)).some((node) => node.id === nodeId);
  if (!ownsNode) return res.status(404).json({ error: "Unknown node" });
  const grant = await store.createLinkGrant(account.id, nodeId, LINK_GRANT_TTL_MS);
  res.json({ ok: true, grant, nodeId, relayUrl: relayUrlForNode(nodeId) });
}));

// Account-session pairing: a node asks whether a browser/app grant belongs to
// the same account and is scoped to this node. If yes, the node may trust that
// device and wrap its room key over the relay, removing the QR bootstrap step
// for signed-in users.
app.post("/node/authorize-client", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const token = String(req.body?.sessionToken ?? "").trim();
  const client = await store.resolveClient(token);
  if (!client || client.accountId !== node.accountId || (client.nodeId && client.nodeId !== node.id))
    return res.status(403).json({ ok: false, error: "This device isn't authorized for this node." });
  const devicePublicKeyB64 = String(req.body?.devicePublicKeyB64 ?? "").trim();
  if (devicePublicKeyB64) {
    try {
      await store.registerPairedDevice(node.accountId, devicePublicKeyB64, String(req.body?.label ?? "Device"));
    } catch (err) {
      // Surface the concrete reason (e.g. device limit reached) so the node can
      // relay it to the client instead of a bare "pairing rejected".
      const status = Number((err as { status?: number }).status) || 400;
      return res.status(status).json({ ok: false, error: (err as Error).message || "Could not register device" });
    }
  }
  res.json({ ok: true });
}));

app.post("/client/relay-ticket", asyncHandler(async (req, res) => {
  // Accepts either an account session token or a node-scoped link grant.
  const resolved = await store.resolveClient(bearer(req));
  if (!resolved) return res.status(401).json({ error: "Unauthorized" });
  // Shard placement is keyed by the TARGET node. A node-scoped grant pins the
  // node; an account session must say which node it's connecting to (the client
  // already knows — it puts the same nodeId in the relay URL). If a node-scoped
  // grant is used against a different node, refuse rather than mis-route.
  const requestedNodeId = typeof req.body?.nodeId === "string" && req.body.nodeId.length > 0 ? req.body.nodeId : null;
  if (resolved.nodeId && requestedNodeId && requestedNodeId !== resolved.nodeId) {
    return res.status(403).json({ error: "Token not valid for this node" });
  }
  const targetNodeId = resolved.nodeId ?? requestedNodeId;
  try {
    const ticket = await store.createRelayTicket({ role: "client", accountId: resolved.accountId, nodeId: resolved.nodeId });
    relayTicketMetrics.clientMinted += 1;
    res.json({ ok: true, ticket, relayUrl: relayUrlForNode(targetNodeId) });
  } catch (error) {
    relayTicketMetrics.clientFailed += 1;
    console.error(`[relay-ticket] failed to mint client ticket accountId=${resolved.accountId} nodeId=${targetNodeId ?? "unknown"}:`, error);
    throw error;
  }
}));

// --- Billing (stub) -----------------------------------------------------

app.post("/billing/checkout", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const plan = normalizePlan(String(req.body?.plan ?? "pro")) as Plan;
  if (plan !== "pro" && !(plan === "team" && stripePrices.team)) return res.status(400).json({ error: "Invalid plan" });

  if (!stripe) {
    if (process.env.NODE_ENV === "production") throw new Error("STRIPE_SECRET_KEY is required for production checkout");
    return res.json({ ok: true, checkoutUrl: `https://billing.example/checkout?plan=${plan}`, plan, dev: true });
  }

  const price = stripePrices[plan];
  if (!price) return res.status(500).json({ error: `Missing Stripe price env for ${plan}` });

  let customer = account.stripeCustomerId;
  if (!customer) {
    const created = await stripe.customers.create({ email: account.email, metadata: { accountId: account.id } });
    customer = created.id;
    await store.setStripeCustomer(account.id, customer);
  }

  const successUrl = process.env.BILLING_SUCCESS_URL ?? `${baseUrl(req)}/?checkout=success`;
  const cancelUrl = process.env.BILLING_CANCEL_URL ?? `${baseUrl(req)}/?checkout=cancel`;
  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: account.id,
    metadata: { accountId: account.id, plan },
    subscription_data: { metadata: { accountId: account.id, plan } },
  });

  const checkoutUrl = checkout.url;
  if (!checkoutUrl) throw new Error("Stripe did not return a checkout URL");
  res.json({ ok: true, checkoutUrl, plan });
}));

app.post("/billing/portal", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  if (!stripe) {
    if (process.env.NODE_ENV === "production") throw new Error("STRIPE_SECRET_KEY is required for production billing portal");
    return res.json({ ok: true, portalUrl: `https://billing.example/portal?account=${encodeURIComponent(account.id)}`, dev: true });
  }

  let customer = account.stripeCustomerId;
  if (!customer) {
    const created = await stripe.customers.create({ email: account.email, metadata: { accountId: account.id } });
    customer = created.id;
    await store.setStripeCustomer(account.id, customer);
  }

  const returnUrl = process.env.BILLING_PORTAL_RETURN_URL ?? `${baseUrl(req)}/`;
  const portal = await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
  const portalUrl = portal.url;
  if (!portalUrl) throw new Error("Stripe did not return a billing portal URL");
  res.json({ ok: true, portalUrl });
}));

app.post("/billing/webhook", asyncHandler(async (req, res) => {
  if (!stripe) {
    if (process.env.NODE_ENV === "production") throw new Error("STRIPE_SECRET_KEY is required for production webhooks");
    const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) : req.body;
    const accountId = String(body?.accountId ?? "");
    const plan = normalizePlan(String(body?.plan ?? "")) as Plan;
    if (accountId && ["free", "pro", "team"].includes(plan)) await store.setPlan(accountId, plan, body?.stripeCustomerId);
    return res.json({ received: true, dev: true });
  }

  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");
  if (!signature || Array.isArray(signature)) return res.status(400).json({ error: "Missing Stripe signature" });

  const event = stripe.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const accountId = String(session.metadata?.accountId ?? session.client_reference_id ?? "");
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
    if (accountId && customerId) await store.setStripeCustomer(accountId, customerId);
  } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
    const accountId = String(subscription.metadata.accountId ?? "");
    const account = accountId ? await store.getAccount(accountId) : customerId ? await store.accountFromStripeCustomer(customerId) : undefined;
    if (account) {
      const nextPlan = subscriptionIsPaid(subscription) ? planFromSubscription(subscription) : "free";
      await store.setSubscriptionState(account.id, {
        plan: nextPlan,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
      });
    }
  } else if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
    const accountId = String(subscription.metadata.accountId ?? "");
    const account = accountId ? await store.getAccount(accountId) : customerId ? await store.accountFromStripeCustomer(customerId) : undefined;
    if (account) {
      await store.setSubscriptionState(account.id, {
        plan: "free",
        stripeCustomerId: customerId,
        stripeSubscriptionId: null,
        subscriptionStatus: subscription.status,
      });
    }
  }

  res.json({ received: true });
}));

// --- Internal: relay introspection -------------------------------------
// The relay verifies tokens here instead of holding account data itself.
// Protected by a shared secret (RELAY_SECRET). These endpoints reveal only
// routing metadata (ids), never session content.
function requireRelay(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.RELAY_SECRET ?? "dev-relay-secret";
  if (bearer(req) !== secret) return res.status(401).json({ error: "Unauthorized relay" });
  next();
}

app.post("/internal/introspect/node", requireRelay, asyncHandler(async (req, res) => {
  // The relay presents a single-use ticket (not a reusable bearer); consuming
  // it here both verifies and invalidates it.
  const ticket = await store.consumeRelayTicket(String(req.body?.token ?? ""));
  if (!ticket || ticket.role !== "node" || !ticket.nodeId) return res.status(404).json({ error: "Invalid node ticket" });
  const entitlements = await store.entitlements(ticket.accountId);
  // Enforce the node cap at connect too, not just at enroll — otherwise an
  // account that downgrades (e.g. Individual → Free) keeps every already-enrolled
  // node reachable forever. The oldest `maxNodes` nodes stay allowed; the rest are
  // rejected but remain enrolled, so re-upgrading restores them with no re-enroll.
  if (entitlements.maxNodes !== undefined) {
    const allowed = (await store.listNodes(ticket.accountId))
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, entitlements.maxNodes)
      .some((n) => n.id === ticket.nodeId);
    if (!allowed) return res.status(403).json({ error: "Node over plan limit" });
  }
  res.json({ nodeId: ticket.nodeId, accountId: ticket.accountId, entitlements });
}));

app.post("/internal/introspect/session", requireRelay, asyncHandler(async (req, res) => {
  const ticket = await store.consumeRelayTicket(String(req.body?.token ?? ""));
  if (!ticket || ticket.role !== "client") return res.status(404).json({ error: "Invalid client ticket" });
  // `nodeId` (when present) restricts a link grant to a single node; the relay
  // enforces it. `null` means an account-wide session token.
  res.json({
    accountId: ticket.accountId,
    nodeId: ticket.nodeId,
    entitlements: await store.entitlements(ticket.accountId),
  });
}));

app.post("/internal/node-status", requireRelay, asyncHandler(async (req, res) => {
  const nodeId = String(req.body?.nodeId ?? "");
  await store.setNodeOnline(nodeId, Boolean(req.body?.online));
  res.json({ ok: true });
}));

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status = (error as { status?: number })?.status ?? 500;
  const message = String(error instanceof Error ? error.message : error);
  // Deliberate client errors (4xx) carry an explicit status and a message meant
  // for the caller (e.g. "Node limit reached"). Anything else is an unexpected
  // server-side failure — a DB blip, a transient DNS error like
  // "getaddrinfo EAI_AGAIN postgres", a bug — whose raw message leaks internal
  // infrastructure detail and is useless to the user. Log it server-side and
  // return a generic message so the sign-in card and ticket toast don't surface
  // Postgres hostnames or stack internals.
  if (status >= 500) {
    console.error(`Unhandled ${status} on ${req.method} ${req.path}:`, error);
    return res.status(status).json({ error: "Something went wrong on our end. Please try again." });
  }
  res.status(status).json({ error: message });
});

const server = app.listen(port, () => {
  const storeName = process.env.DATABASE_URL ? "Postgres" : "in-memory";
  console.log(`Control plane (${storeName}) listening on http://localhost:${port}`);
});

async function shutdown() {
  server.close();
  if ("close" in store && typeof store.close === "function") await store.close();
}

process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
