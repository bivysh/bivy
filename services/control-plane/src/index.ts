// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import path from "node:path";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import Stripe from "stripe";
import webpush from "web-push";
import { type Account, type NodeRecord, type Plan, type NotificationKind, type EphemeralQueueDefault, type EphemeralNodeConfig, type QueueRouting, type HostedProvisioning, LEGACY_PLAN_IDS, LOGIN_TOKEN_TTL_MS, NOTIFICATION_KINDS } from "./store.js";
import { maybeAutoProvision, planAutoProvision, mintHostedInstallationToken } from "./ephemeral-provisioner.js";
import { hostedEncryptionAvailable, hostedPrimaryKid } from "./hosted-crypto.js";
import { countActiveAccountSessions } from "./session-count.js";
import { createStore } from "./store-factory.js";
import { AutomationScheduler, nextOccurrence, normalizeSchedule } from "./schedule.js";
import { parseShardUrls, shardForNode } from "./relay-shards.js";
import { safeReturnPath } from "./redirect.js";
import { register, httpMetricsMiddleware, bindRelayTicketMetrics, startUsageCollector, recordFunnelEvent } from "./metrics.js";
import { initSentry } from "./instrument.js";
import { sanitizeEvidencePatch } from "./run-evidence.js";
import {
  verifyGithubSignature,
  verifyLinearSignature,
  parseLinearIssueEvent,
  parseGithubIssueEvent,
  pickIssueRoutingLabel,
  pickRoutingLabel,
  parseGithubCommentEvent,
  pickCommentRoutingLabel,
  parseInstallationId,
  verifySlackSignature,
  parseSlackCommand,
  applyDefaultNode,
  meetsTriggerAccess,
  verifyAutomationSignature,
  parseAutomationEvent,
  renderAutomationInstruction,
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
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_PRICE_PRO) {
    problems.push("STRIPE_PRICE_PRO is required when Stripe billing is enabled");
  }
  if (!process.env.PUBLIC_CONTROL_PLANE_URL) {
    // Without a fixed public URL, baseUrl() falls back to the request's
    // Host/X-Forwarded-Host header — which an attacker controls. That header is
    // what builds the magic-link / OAuth sign-in URL emailed to the user, so a
    // spoofed Host would send a genuine email pointing at the attacker's host
    // and leak the single-use login token. Require it in production.
    problems.push("PUBLIC_CONTROL_PLANE_URL must be set in production (sign-in link URLs must not be derived from request headers)");
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
const automationScheduler = new AutomationScheduler(
  store,
  Math.max(1_000, Number(process.env.AUTOMATION_SCHEDULER_INTERVAL_MS) || 15_000),
);
automationScheduler.start();

// Optional error reporting. Resolves to no-ops unless SENTRY_DSN is set, and only
// then is @sentry/node loaded (see instrument.ts).
const Sentry = await initSentry();

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
  // Unattended provisioning: any enqueued work triggers a hosted-provisioning
  // check (gated + deduped inside). Fire-and-forget; never blocks the notify.
  void maybeAutoProvision(store, accountId, provisionEnv());
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

// Bootstrap URLs the control plane bakes into a machine it launches itself.
// These must be PUBLIC (the VM reaches them); without PUBLIC_CONTROL_PLANE_URL a
// hosted machine can't reach us, so hosted provisioning is effectively off.
const provisionEnv = (): { cpBaseUrl: string; relayUrl: string } => ({
  cpBaseUrl: publicControlPlaneUrl ?? `http://localhost:${process.env.PORT ?? 8080}`,
  relayUrl: relayPublicUrl,
});
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const vapidPublicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || "";
const vapidSubject = process.env.WEB_PUSH_SUBJECT || "mailto:support@bivy.sh";
const webPushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);
if (webPushEnabled) webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
// A Stripe-backed deployment is a billed hosted service, so entitlement
// enforcement is always on there and cannot be accidentally disabled by a stale
// environment flag. Self-hosted/no-billing stacks retain their explicit opt-in
// behavior and remain unlimited by default.
const enforceEntitlements = Boolean(stripe) || process.env.ENFORCE_ENTITLEMENTS === "1";
// Observe-only mode is retained for no-billing staging: count and report jobs but
// do not block them. A Stripe-backed deployment always hard-enforces, so a stale
// staging flag cannot silently disable the paid plan boundary in production.
const observeRunLimitOnly = !stripe && process.env.RUN_LIMIT_OBSERVE_ONLY === "1";
const enforceRunLimit = enforceEntitlements && !observeRunLimitOnly;
async function accountPushAllowed(accountId: string): Promise<boolean> {
  if (!enforceEntitlements) return true;
  return (await store.entitlements(accountId)).pushEnabled;
}

// How many days back the free-tier automation window looks. A ROLLING window (not a
// calendar week) — capacity frees up gradually as individual runs age out the far
// edge, which fits bursty dev work far better than a hard periodic reset.
const RUN_WINDOW_DAYS = 7;

// Start of the current rolling run window, as an ISO timestamp — `now` minus the
// window length. Computed rather than stored, so there is no counter to reset and
// no cron: the count is just run_starts with `started_at >= this`.
function runWindowStartIso(): string {
  return new Date(Date.now() - RUN_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
}

// Soft-cap grace: how many runs PAST the plan's window limit still go through
// (warned, not blocked) before a hard refusal. The cap converts by nudging, not by
// slapping someone mid-task the instant they cross — so the first over-limit run is
// a courtesy ("you're over your free runs — this one's on us"), and only further
// runs are refused until capacity ages back in. Applied against the rolling window,
// so the courtesy naturally recurs as the window slides.
const RUN_GRACE = 1;

// The account's unattended-automation allowance for the current rolling window.
// Only `automation:*` starts (GitHub, Slack, webhook, scheduled) count; interactive
// CLI/app sessions stay unlimited. `limit` is the plan cap (undefined means paid),
// `used` is the queued automation started in the window,
// `warn` whether this run is in the grace band (over the limit but still allowed),
// `exhausted` whether a new run must be refused (over limit + grace). Blocking is
// only in effect under `ENFORCE_ENTITLEMENTS=1` AND not `RUN_LIMIT_OBSERVE_ONLY=1`
// (see enforceRunLimit); otherwise both flags stay false so runners go unlimited,
// but `used` is always reported for display. One queued work item = one automation run.
async function runAllowance(accountId: string): Promise<{ limit?: number; used: number; warn: boolean; exhausted: boolean }> {
  const limit = (await store.entitlements(accountId)).weeklyRunLimit;
  if (typeof limit !== "number") return { limit: undefined, used: 0, warn: false, exhausted: false };
  const used = await store.countRunStartsSince(accountId, runWindowStartIso(), "automation:");
  if (!enforceRunLimit) return { limit, used, warn: false, exhausted: false };
  return { limit, used, warn: used >= limit && used < limit + RUN_GRACE, exhausted: used >= limit + RUN_GRACE };
}
const stripePrices: Partial<Record<Plan, string>> = {
  pro: process.env.STRIPE_PRICE_PRO,
  team: process.env.STRIPE_PRICE_TEAM,
};

export interface PublicPlanPrice {
  id: string;
  currency: string;
  unitAmount: number | null;
  interval?: string;
  intervalCount?: number;
  label: string;
}

let planPriceCache: { expiresAt: number; value: Partial<Record<Plan, PublicPlanPrice>> } | undefined;

function stripeAmountLabel(price: Stripe.Price): string {
  if (price.unit_amount == null) return "Contact us";
  const currency = price.currency.toUpperCase();
  const fractionDigits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const amount = price.unit_amount / 10 ** fractionDigits;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: amount % 1 === 0 ? 0 : fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
  const recurring = price.recurring;
  if (!recurring) return formatted;
  const count = recurring.interval_count;
  const interval = recurring.interval === "month" ? "mo" : recurring.interval === "year" ? "yr" : recurring.interval;
  return count === 1 ? `${formatted}/${interval}` : `${formatted}/${count} ${interval}`;
}

async function publicPlanPrices(): Promise<Partial<Record<Plan, PublicPlanPrice>>> {
  if (!stripe) return {};
  if (planPriceCache && planPriceCache.expiresAt > Date.now()) return planPriceCache.value;
  const entries = await Promise.all(
    Object.entries(stripePrices).map(async ([plan, id]) => {
      if (!id) return undefined;
      const price = await stripe.prices.retrieve(id);
      return [plan as Plan, {
        id: price.id,
        currency: price.currency,
        unitAmount: price.unit_amount,
        interval: price.recurring?.interval,
        intervalCount: price.recurring?.interval_count,
        label: stripeAmountLabel(price),
      } satisfies PublicPlanPrice] as const;
    }),
  );
  const value = Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))) as Partial<Record<Plan, PublicPlanPrice>>;
  planPriceCache = { expiresAt: Date.now() + 5 * 60_000, value };
  return value;
}

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
// Mirror the ticket counters into the Prometheus registry, and start refreshing
// the business/usage gauges from the store on an interval.
bindRelayTicketMetrics(() => relayTicketMetrics);
startUsageCollector(store);

// Housekeeping: periodically drop run-start rows older than the rolling window
// (plus a day of slack) so the table can't grow without bound. Rows past the
// window are never counted again, so this is safe. `.unref()` keeps the timer from
// holding the process open (e.g. in tests); also swept once at boot.
const RUN_STARTS_RETENTION_MS = (RUN_WINDOW_DAYS + 1) * 24 * 60 * 60_000;
async function pruneOldRunStarts() {
  try {
    await store.pruneRunStartsBefore(new Date(Date.now() - RUN_STARTS_RETENTION_MS).toISOString());
  } catch (error) {
    console.error("[run-starts] prune failed:", error);
  }
}
void pruneOldRunStarts();
setInterval(pruneOldRunStarts, 6 * 60 * 60_000).unref();

// Housekeeping: periodically drop expired rows from the short-lived, single-use
// auth tables (login tokens, sessions, link grants, relay tickets, device
// logins). Each is normally deleted on successful consumption, but an
// abandoned attempt (closed tab, retried client, a node that never finishes
// introspection) otherwise leaves a dead row behind forever — see
// pruneExpiredAuthTokens in postgres-store.ts. Same unref'd-interval shape as
// pruneOldRunStarts above; also swept once at boot.
async function pruneExpiredAuthTokens() {
  try {
    await store.pruneExpiredAuthTokens(new Date().toISOString());
  } catch (error) {
    console.error("[auth-tokens] prune failed:", error);
  }
}
void pruneExpiredAuthTokens();
setInterval(pruneExpiredAuthTokens, 60 * 60_000).unref();

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
app.use("/webhooks/automation", express.raw({ type: () => true, limit: "64kb" }));
app.use("/webhooks", express.raw({ type: () => true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
// Time every request under its matched route pattern for the /metrics
// histogram. Cheap; records on response finish. Must run before the routes.
app.use(httpMetricsMiddleware);
// Liveness: the process is up and serving. Deliberately does NOT touch the
// database — restarting the app can't fix an unreachable DB, so tying liveness
// to the DB would just kill a healthy process during a transient blip and drop
// every live WebSocket. Readiness (below) is where DB reachability belongs.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Prometheus exposition for Alloy/Prometheus scrapers. Scraped over the internal
// docker network only — Caddy blocks /metrics publicly. register.metrics() is
// async (gauge collect callbacks), so resolve then send. See
// docs/ops/monitoring.md in bivysh/bivy-cloud.
app.get("/metrics", (_req, res, next) => {
  register
    .metrics()
    .then((body) => {
      res.setHeader("Content-Type", register.contentType);
      res.end(body);
    })
    .catch(next);
});
// Backcompat: the pre-Prometheus JSON counters.
app.get("/metrics.json", (_req, res) => {
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
  // Settings is also URL-routed (`/settings`, `/settings/:view` — see #78 and
  // packages/web/src/router.ts), so a cold load / reload / copied link on
  // either needs the same app-shell fallback. No existing JSON API lives at
  // these paths (only `github.com/settings/...` strings appear elsewhere in
  // this file), so nothing here is shadowed.
  app.get(/^\/settings(?:\/.+)?$/, (_req, res) => {
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

// Fleet-wide fixed-window limits for unauthenticated, side-effecting auth
// endpoints. The shared Postgres counter means adding replicas cannot multiply
// the email/OAuth allowance and requests need no load-balancer affinity.
function clientIp(req: Request): string {
  return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}
/** True (and responds 429) if this IP or email has exceeded the auth-email budget. */
async function authEmailRateLimited(req: Request, res: Response, email: string): Promise<boolean> {
  if (
    await store.rateLimitExceeded("auth-email-ip", clientIp(req), 20, 60_000) ||
    await store.rateLimitExceeded("auth-email-addr", email, 5, 60_000)
  ) {
    res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
    return true;
  }
  return false;
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

// The device-flow OAuth/magic-link tab that fails must not be a dead end: give
// it a way back. "Back to sign in" is a plain same-origin link (always works,
// even for a tab opened from an email/QR link that can't self-close). "Close
// this tab" wires window.close() for the app-opened tab — whitelisted by hash
// like signedInCloseScript, since the global script-src is 'self' only.
const closeTabScript = `var b=document.getElementById('close-tab');if(b){b.addEventListener('click',function(){try{window.close();}catch(e){/* not closable */}});}`;
const closeTabScriptHash = `sha256-${createHash("sha256").update(closeTabScript).digest("base64")}`;

function signInFailedHtml(detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in failed</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0f20;color:#eef2ff;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
.card{background:#0f1530;border:1px solid #233056;border-radius:16px;padding:32px 40px;text-align:center;max-width:360px}
h1{font-size:20px;margin:0 0 8px}p{color:#9aa6cf;margin:6px 0;line-height:1.45}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}
.btn{display:block;padding:11px 16px;border-radius:10px;border:1px solid #2b3a66;background:#1b2545;color:#eef2ff;font:inherit;font-size:15px;text-decoration:none;cursor:pointer}
.btn.ghost{background:transparent}</style></head>
<body><div class="card"><h1>Sign-in failed</h1><p>${escapeHtml(detail)}</p>
<div class="actions"><a class="btn" href="/">Back to sign in</a><button id="close-tab" class="btn ghost" type="button">Close this tab</button></div></div>
<script>${closeTabScript}</script>
</body></html>`;
}

// Send the device sign-in failure page, relaxing this one response's CSP just
// enough to run the close-button snippet (whitelisted by hash) and its inline
// styles; the global script-src stays 'self'-only for every other route.
function sendSignInFailed(res: Response, status: number, detail: string): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self' '${closeTabScriptHash}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  res.status(status).type("html").send(signInFailedHtml(detail));
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
// Accept the BIVY_-prefixed names as a fallback. GitHub reserves the `GITHUB_`
// prefix for Actions secrets, so the canonical secrets are stored as
// BIVY_GITHUB_OAUTH_CLIENT_ID / _SECRET (see scripts/sync-github-env.sh). A
// deployment that forwards its Actions secrets into the runtime environment
// verbatim ends up with the BIVY_-prefixed names set but the plain ones empty —
// which silently disables GitHub sign-in and surfaces as "the authorization code
// could not be exchanged" (an empty client secret) at token-exchange time.
// Reading either name removes that entire class of misconfiguration.
const githubClientId = process.env.GITHUB_OAUTH_CLIENT_ID || process.env.BIVY_GITHUB_OAUTH_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET || process.env.BIVY_GITHUB_OAUTH_CLIENT_SECRET;
const githubConfigured = Boolean(githubClientId && githubClientSecret);

// Short-lived CSRF/login state lives in Postgres, not process memory: GitHub may
// return the callback to any healthy control-plane replica behind the load
// balancer. Consumption is atomic and single-use in the store.

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
  if (await authEmailRateLimited(req, res, email)) return;

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
  recordFunnelEvent("sign_in_completed", "email_api", account.plan);
  res.json({ ok: true, token, account: { id: account.id, email: account.email, plan: account.plan } });
}));

app.get("/auth/magic-link/consume", asyncHandler(async (req, res) => {
  const loginToken = String(req.query?.token ?? "").trim();
  const deviceId = String(req.query?.device ?? "").trim();
  const account = await store.consumeLoginToken(loginToken);
  if (!account) return sendSignInFailed(res, 401, "This sign-in link is invalid or has expired. Request a new one from the sign-in screen.");
  // Device-login flow (hands-free CLI sign-in): mark the pending device login
  // complete and tell the user to return to their terminal. No session is
  // embedded here — the CLI mints it when it polls.
  if (deviceId) {
    await store.completeDeviceLogin(deviceId, account.id);
    recordFunnelEvent("sign_in_completed", "email_device", account.plan);
    return sendDeviceSignedIn(res, account.email);
  }
  const session = await store.createSession(account.id);
  recordFunnelEvent("sign_in_completed", "email_browser", account.plan);
  const payload = b64urlJson({ session, controlPlane: baseUrl(req), relay: relayPublicUrl });
  res.redirect(`/#${payload}`);
}));

// Hands-free CLI sign-in. The CLI starts a device login, the user clicks the
// emailed link in a browser, and the CLI polls for completion. The session is
// minted only at successful poll time, so no bearer is stored at rest.
app.post("/auth/device/start", asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Invalid email" });
  if (await authEmailRateLimited(req, res, email)) return;

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
app.get("/auth/github/start", asyncHandler(async (req, res) => {
  if (!githubConfigured) return res.status(501).type("html").send("<h1>GitHub sign-in is not configured</h1><p>Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.</p>");
  // Unauthenticated and side-effecting, same shape as magic-link start. The
  // shared counter applies one allowance across the whole replica fleet.
  if (await store.rateLimitExceeded("oauth-github-start-ip", clientIp(req), 20, 60_000)) {
    return res.status(429).type("html").send("<h1>Too many requests</h1><p>Please wait a minute and try again.</p>");
  }
  const deviceId = String(req.query.device ?? "").trim() || undefined;
  // Land back on the path the sign-in started from (for a client served under a
  // sub-path) instead of always dumping to root. Ignored for the device flow,
  // which finishes in-place via polling rather than a redirect.
  const returnPath = deviceId ? undefined : safeReturnPath(req.query.return, "/");
  const state = await store.createOAuthState({ deviceId, returnPath });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", githubClientId!);
  url.searchParams.set("redirect_uri", `${baseUrl(req)}/auth/github/callback`);
  url.searchParams.set("scope", "read:user user:email"); // minimal scope at login
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  res.redirect(url.toString());
}));

app.get("/auth/github/callback", asyncHandler(async (req, res) => {
  if (!githubConfigured) return res.status(501).json({ error: "GitHub sign-in not configured" });
  const code = String(req.query.code ?? "").trim();
  const state = String(req.query.state ?? "").trim();
  const stored = await store.consumeOAuthState(state);
  if (!code || !stored) {
    // No usable state means no trustworthy return path, so land on root — but
    // still return the user to the sign-in card (with a reason) rather than a
    // dead-end error page they'd have to navigate away from by hand.
    return res.redirect(`/?authError=expired`);
  }
  const { email, reason } = await githubPrimaryEmail(code, `${baseUrl(req)}/auth/github/callback`);
  if (!email || !validEmail(email)) {
    const errCode = reason === "token-exchange" ? "github-config" : "github-email";
    // The device (CLI/app) flow finishes in a throwaway browser tab that never
    // returns to the client, so an HTML page is the only feedback available
    // there — but not a dead end: it offers "Back to sign in" and "Close this
    // tab" so the user can recover without hand-editing the URL. The browser flow
    // instead bounces back to the sign-in card with a reason code, landing the
    // user somewhere they can immediately retry or switch to email sign-in.
    if (stored.deviceId) {
      const detail =
        reason === "token-exchange"
          ? "Couldn't complete GitHub sign-in — the authorization code could not be exchanged. This is a server configuration issue; please try again in a moment."
          : "GitHub didn't return a verified email. Make sure your GitHub account has a verified email address and that you granted the email permission, then try again.";
      return sendSignInFailed(res, 400, detail);
    }
    const path = safeReturnPath(stored.returnPath, "/");
    return res.redirect(`${path}${path.includes("?") ? "&" : "?"}authError=${errCode}`);
  }
  // Resolve by verified email → links GitHub and magic-link to one account.
  const account = await store.findOrCreateAccount(email);
  if (stored.deviceId) {
    await store.completeDeviceLogin(stored.deviceId, account.id);
    recordFunnelEvent("sign_in_completed", "github_device", account.plan);
    return sendDeviceSignedIn(res, account.email);
  }
  const session = await store.createSession(account.id);
  recordFunnelEvent("sign_in_completed", "github_browser", account.plan);
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
  recordFunnelEvent("sign_in_completed", "dev", account.plan);
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
    pricing: await publicPlanPrices(),
    counts: {
      nodes: (await store.listNodes(account.id)).length,
      devices: await store.countPairedDevices(account.id),
      // Active-session count only (excludes saved / offline-node entries) so the
      // "Session limit reached — X/N" banner matches what enforcement counts.
      sessions: countActiveAccountSessions(
        await store.listAccountSessions(account.id),
        await store.listNodes(account.id),
      ),
      // Unattended automation started in the current rolling window. The legacy
      // property name stays compatible with existing clients; interactive sessions
      // are excluded and unlimited on every plan.
      runsThisWeek: (await runAllowance(account.id)).used,
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
  if (result.created) recordFunnelEvent("node_enrolled", "api", account.plan);
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
  const newRuns = await store.replaceNodeSessions(node.accountId, node.id, sessions);
  if (newRuns > 0) recordFunnelEvent("run_started", "session", (await store.entitlements(node.accountId)).plan, newRuns);
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
  // Incremental single-session upsert. This used to read the node's ENTIRE
  // session index and rewrite it wholesale on every call; since a session's
  // status flips constantly, that was O(sessions) work per flip (O(sessions²)
  // in aggregate) and a wholesale DELETE+reinsert per event — a primary cause
  // of the control plane pegging a core under load. Removals are still handled
  // by the periodic full advertise via POST /node/sessions.
  const advert = sessionAdvertsFrom([{ ...req.body, sessionId: req.params.sessionId }]);
  let newRuns = 0;
  for (const s of advert) if (await store.upsertNodeSession(node.accountId, node.id, s)) newRuns += 1;
  if (newRuns > 0) recordFunnelEvent("run_started", "session", (await store.entitlements(node.accountId)).plan, newRuns);
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
  "api.sprites.dev",
  "api.e2b.app",
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
  // Quick ephemeral servers are available on every plan. Interactive runner
  // launches do not consume the automation allowance; a runner serving queued work
  // is metered when that work enters `running`, like every other automation job.
  const account = (req as Request & { account: Account }).account;
  const ent = await store.entitlements(account.id);
  if (enforceEntitlements && !ent.ephemeralEnabled) {
    return res.status(403).json({ error: "Ephemeral servers aren't available on your plan." });
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
    // Do NOT auto-follow redirects: the host allowlist is enforced once, above,
    // so a 3xx from an allowlisted provider (open redirect) could otherwise
    // bounce this request to an internal target like 169.254.169.254 (SSRF).
    const upstream = await fetch(url, { method, headers, body: payload, signal: controller.signal, redirect: "manual" });
    if (upstream.status >= 300 && upstream.status < 400) {
      return res.status(502).json({ error: "Refusing to follow a redirect from the provider host (SSRF guard)." });
    }
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

// E2E GitHub App private-key vault (issue #88) — opt-in, per-app sibling of the
// model-auth vault above. Same guarantee: the control plane stores only
// ciphertext and per-node wrapped vault keys, never a plaintext app key. A node
// lists every app the account has a vault for in one call (it may not hold
// them all yet) so a newly opted-in node discovers apps without an extra round
// trip per app; wrapped keys and requests are likewise returned across apps and
// the node filters to what it can use/answer.
app.get("/node/github-app-vault", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  res.json({
    ok: true,
    vaults: await store.listGithubAppVaults(node.accountId),
    wrappedKeys: await store.listGithubAppWrappedKeysForNode(node.accountId, node.id),
    requests: await store.listGithubAppKeyRequests(node.accountId, node.id),
  });
}));

app.put("/node/github-app-vault", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const appId = String(req.body?.appId ?? "").trim();
  const ciphertext = String(req.body?.ciphertext ?? "").trim();
  if (!appId) return res.status(400).json({ error: "Missing appId" });
  if (!ciphertext) return res.status(400).json({ error: "Missing ciphertext" });
  const vault = await store.setGithubAppVault(node.accountId, appId, node.id, ciphertext);
  res.json({ ok: true, vault });
}));

app.post("/node/github-app-key/request", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const appId = String(req.body?.appId ?? "").trim();
  const publicKey = String(req.body?.publicKey ?? "").trim();
  if (!appId) return res.status(400).json({ error: "Missing appId" });
  if (!publicKey) return res.status(400).json({ error: "Missing publicKey" });
  await store.requestGithubAppWrappedKey(node.accountId, appId, node.id, publicKey);
  res.json({ ok: true });
}));

app.put("/node/github-app-key/wrapped", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const appId = String(req.body?.appId ?? "").trim();
  const targetNodeId = String(req.body?.targetNodeId ?? "").trim();
  const wrappedKey = String(req.body?.wrappedKey ?? "").trim();
  const wrappedByPublicKey = String(req.body?.wrappedByPublicKey ?? "").trim();
  if (!appId) return res.status(400).json({ error: "Missing appId" });
  if (!targetNodeId || !wrappedKey || !wrappedByPublicKey) return res.status(400).json({ error: "Missing targetNodeId, wrappedByPublicKey, or wrappedKey" });
  const rec = await store.setGithubAppWrappedKey(node.accountId, appId, targetNodeId, node.id, wrappedByPublicKey, wrappedKey);
  res.json({ ok: true, wrappedKey: rec });
}));

// Plaintext (non-secret) per-node provider connection summary — pushed by the
// node alongside its encrypted model-auth vault (see pushProviderSummaryToControlPlane
// in src/server.ts) so /nodes can show every enrolled node's OAuth connect/expiry
// status without the client connecting to each one. Only {id, name, configured,
// expiresAt} per provider; never credential material or account identity.
app.put("/node/provider-summary", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const rawProviders = Array.isArray(req.body?.providers) ? req.body.providers : [];
  const providers = rawProviders
    .map((p: unknown) => {
      if (!p || typeof p !== "object") return null;
      const rec = p as Record<string, unknown>;
      const id = String(rec.id ?? "").trim();
      if (!id) return null;
      const out: { id: string; name?: string; configured: boolean; expiresAt?: number } = {
        id,
        configured: Boolean(rec.configured),
      };
      if (typeof rec.name === "string" && rec.name.trim()) out.name = rec.name.trim();
      if (typeof rec.expiresAt === "number" && Number.isFinite(rec.expiresAt)) out.expiresAt = rec.expiresAt;
      return out;
    })
    .filter((p: unknown): p is { id: string; name?: string; configured: boolean; expiresAt?: number } => p !== null);
  await store.setNodeProviders(node.id, providers);
  res.json({ ok: true });
}));

// --- Work queue (E2 GitHub webhook sink, E4 Slack) ----------------------
// Inbound front doors enqueue WorkItems; the node (outbound-only) pulls them.
// The control plane only routes metadata — the node runs the work with its own
// token, so issue/agent content never reaches us.

function publicSlackHook(req: Request, hook: Awaited<ReturnType<typeof store.getInboundHook>>) {
  if (!hook) return undefined;
  return {
    id: hook.id,
    endpoint: `${baseUrl(req)}/webhooks/slack/${hook.id}`,
    enabled: hook.enabled !== false,
    defaultNode: hook.defaultNode,
    createdAt: hook.createdAt,
    updatedAt: hook.updatedAt,
  };
}

// Slack creates the signing secret; Bivy stores it only for request signature
// verification and never returns it. The endpoint is then pasted into a Slack
// app's slash-command Request URL.
app.get("/account/slack-hook", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const hook = (await store.listInboundHooks(account.id, "slack"))[0];
  res.json({ hook: publicSlackHook(req, hook) ?? null });
}));

app.post("/account/slack-hook", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const signingSecret = String(req.body?.signingSecret ?? "").trim();
  const defaultNode = String(req.body?.defaultNode ?? "").trim();
  if (signingSecret.length < 16 || signingSecret.length > 256) {
    return res.status(400).json({ error: "Enter the Signing Secret from Slack's Basic Information page." });
  }
  if (defaultNode && !/^[A-Za-z0-9._-]+$/.test(defaultNode)) {
    return res.status(400).json({ error: "Default node contains invalid characters." });
  }
  let hook = await store.createInboundHook(account.id, "slack");
  hook = (await store.setInboundHookSecret(account.id, hook.id, signingSecret)) ?? hook;
  if (defaultNode) hook = (await store.setInboundHookDefaultNode(account.id, hook.id, defaultNode)) ?? hook;
  res.status(201).json({ hook: publicSlackHook(req, hook) });
}));

app.delete("/account/slack-hook", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  for (const hook of await store.listInboundHooks(account.id, "slack")) {
    await store.deleteInboundHook(account.id, hook.id);
  }
  res.json({ ok: true });
}));

function publicLinearHook(req: Request, hook: Awaited<ReturnType<typeof store.getInboundHook>>) {
  if (!hook) return undefined;
  return {
    id: hook.id,
    endpoint: `${baseUrl(req)}/webhooks/linear/${hook.id}`,
    enabled: hook.enabled !== false,
    defaultNode: hook.defaultNode,
    createdAt: hook.createdAt,
    updatedAt: hook.updatedAt,
  };
}

// Linear generates its signing secret only after the webhook URL is created.
// POST without a secret creates a disabled endpoint; POST again with Linear's
// signing secret enables it. The secret is never returned to the client.
app.get("/account/linear-hook", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const hook = (await store.listInboundHooks(account.id, "linear"))[0];
  res.json({ hook: publicLinearHook(req, hook) ?? null });
}));

app.post("/account/linear-hook", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const signingSecret = String(req.body?.signingSecret ?? "").trim();
  const defaultNode = String(req.body?.defaultNode ?? "").trim();
  if (signingSecret && (signingSecret.length < 16 || signingSecret.length > 1_000)) {
    return res.status(400).json({ error: "Enter the signing secret generated by Linear." });
  }
  if (defaultNode && !/^[A-Za-z0-9._-]+$/.test(defaultNode)) {
    return res.status(400).json({ error: "Default node contains invalid characters." });
  }
  let hook = (await store.listInboundHooks(account.id, "linear"))[0];
  if (!hook) {
    hook = await store.createInboundHook(account.id, "linear");
    hook = (await store.updateInboundHook(account.id, hook.id, { enabled: false })) ?? hook;
  }
  if (signingSecret) {
    hook = (await store.setInboundHookSecret(account.id, hook.id, signingSecret)) ?? hook;
    hook = (await store.updateInboundHook(account.id, hook.id, { enabled: true })) ?? hook;
  }
  hook = (await store.setInboundHookDefaultNode(account.id, hook.id, defaultNode || undefined)) ?? hook;
  res.status(signingSecret ? 200 : 201).json({ hook: publicLinearHook(req, hook) });
}));

app.delete("/account/linear-hook", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  for (const hook of await store.listInboundHooks(account.id, "linear")) {
    await store.deleteInboundHook(account.id, hook.id);
  }
  res.json({ ok: true });
}));

// Legacy generic hook creation retained for node/older-client compatibility.
app.post("/account/hooks", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const kind = String(req.body?.kind ?? "github").trim().toLowerCase();
  if (kind !== "github" && kind !== "github_app" && kind !== "linear" && kind !== "slack") return res.status(400).json({ error: "kind must be 'github', 'github_app', 'linear', or 'slack'" });
  const hook = await store.createInboundHook(account.id, kind);
  const url = `${baseUrl(req)}/webhooks/${kind}/${hook.id}`;
  res.json({ ok: true, id: hook.id, kind, secret: hook.secret, url });
}));

function publicAutomationHook(req: Request, hook: Awaited<ReturnType<typeof store.getInboundHook>>) {
  if (!hook) return undefined;
  return {
    id: hook.id,
    endpoint: `${baseUrl(req)}/webhooks/automation/${hook.id}`,
    enabled: hook.enabled !== false,
    templateInstruction: hook.templateInstruction || "",
    routingDefault: hook.routingDefault || "",
    createdAt: hook.createdAt,
    updatedAt: hook.updatedAt,
  };
}

// Generic automations are managed separately from provider hooks. Secrets are
// intentionally omitted from list/update responses and disclosed exactly once
// on create or rotation.
app.get("/account/automation-hooks", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const hooks = await store.listInboundHooks(account.id, "automation");
  const work = (await store.listAutomationRuns(account.id, 100))
    .filter((run) => run.source.startsWith("automation:"))
    .slice(0, 20)
    .map((run) => ({
      id: run.id,
      hookId: run.source.slice("automation:".length),
      status: run.status,
      title: run.title,
      createdAt: run.createdAt,
      claimedAt: run.claimedAt,
      completedAt: run.completedAt,
    }));
  res.json({ hooks: hooks.map((hook) => publicAutomationHook(req, hook)), outcomes: work });
}));

app.post("/account/automation-hooks", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const templateInstruction = String(req.body?.templateInstruction ?? "").trim();
  const routingDefault = String(req.body?.routingDefault ?? "").trim();
  if (!templateInstruction || templateInstruction.length > 2_000) {
    return res.status(400).json({ code: "invalid_request", error: "Template instruction must be 1–2000 characters." });
  }
  if (routingDefault && !/^[A-Za-z0-9._-]+$/.test(routingDefault)) {
    return res.status(400).json({ code: "invalid_request", error: "Routing default contains invalid characters." });
  }
  let hook = await store.createInboundHook(account.id, "automation");
  hook = (await store.updateInboundHook(account.id, hook.id, { templateInstruction, routingDefault })) ?? hook;
  res.status(201).json({ ...publicAutomationHook(req, hook), secret: hook.secret });
}));

app.patch("/account/automation-hooks/:id", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const patch: { enabled?: boolean; templateInstruction?: string; routingDefault?: string } = {};
  if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
  if (typeof req.body?.templateInstruction === "string") {
    const value = req.body.templateInstruction.trim();
    if (!value || value.length > 2_000) return res.status(400).json({ code: "invalid_request", error: "Invalid template instruction." });
    patch.templateInstruction = value;
  }
  if (typeof req.body?.routingDefault === "string") {
    const value = req.body.routingDefault.trim();
    if (value && !/^[A-Za-z0-9._-]+$/.test(value)) return res.status(400).json({ code: "invalid_request", error: "Invalid routing default." });
    patch.routingDefault = value;
  }
  const hook = await store.updateInboundHook(account.id, String(req.params.id), patch);
  if (!hook || hook.kind !== "automation") return res.status(404).json({ code: "not_found", error: "Unknown automation hook." });
  res.json(publicAutomationHook(req, hook));
}));

app.post("/account/automation-hooks/:id/rotate", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const existing = await store.getInboundHook(String(req.params.id));
  if (!existing || existing.accountId !== account.id || existing.kind !== "automation") {
    return res.status(404).json({ code: "not_found", error: "Unknown automation hook." });
  }
  const secret = randomBytes(32).toString("base64url");
  const hook = await store.setInboundHookSecret(account.id, existing.id, secret);
  res.json({ ...publicAutomationHook(req, hook), secret });
}));

// Revoke invalidates the secret and leaves a disabled tombstone so callers get
// the stable `disabled` result rather than an ambiguous 404.
app.delete("/account/automation-hooks/:id", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const existing = await store.getInboundHook(String(req.params.id));
  if (!existing || existing.accountId !== account.id || existing.kind !== "automation") {
    return res.status(404).json({ code: "not_found", error: "Unknown automation hook." });
  }
  await store.setInboundHookSecret(account.id, existing.id, randomBytes(32).toString("base64url"));
  await store.updateInboundHook(account.id, existing.id, { enabled: false });
  res.json({ ok: true });
}));

// Node-side setup helper. The CLI only has a node enrollment token after
// `bivy relay:setup`; let that node create an account-scoped inbound hook so
// GitHub issue setup can be completed from the machine that will run the work,
// without requiring a separate browser/user bearer token in the CLI.
// Replace a hook's verifier secret with one generated by the provider. Linear
// generates its signing secret after the endpoint is created, so setup is
// necessarily create URL → create Linear webhook → adopt displayed secret.
app.post("/account/hooks/:id/secret", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const secret = String(req.body?.secret ?? "").trim();
  if (!secret || secret.length > 1_000) return res.status(400).json({ error: "Missing or invalid secret" });
  const hook = await store.setInboundHookSecret(account.id, String(req.params.id), secret);
  if (!hook) return res.status(404).json({ error: "Unknown hook" });
  res.json({ ok: true, id: hook.id, kind: hook.kind });
}));

app.post("/node/hooks", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const kind = String(req.body?.kind ?? "github").trim().toLowerCase();
  if (kind !== "github" && kind !== "github_app" && kind !== "linear" && kind !== "slack") return res.status(400).json({ error: "kind must be 'github', 'github_app', 'linear', or 'slack'" });
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
      // Who may `@`-mention-trigger a run (issue #259). undefined = "everyone",
      // the behavior before this setting existed.
      triggerAccess: hook.triggerAccess,
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

// Set who may `@`-mention-trigger a run: "everyone" (default), "contributor"
// (any prior relationship with the repo), or "collaborator" (push access
// only). Issue #259 — a public repo otherwise lets any GitHub user trigger a
// run. Account-wide preference stored per hook, same shape as default-node:
// without an appId it applies to every connected app.
app.post("/account/github-app/trigger-access", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const raw = typeof req.body?.triggerAccess === "string" ? req.body.triggerAccess.trim() : "";
  if (raw && raw !== "everyone" && raw !== "contributor" && raw !== "collaborator") {
    return res.status(400).json({ error: "triggerAccess must be 'everyone', 'contributor', or 'collaborator'" });
  }
  const triggerAccess = raw === "contributor" || raw === "collaborator" ? raw : undefined;
  const appId = typeof req.body?.appId === "string" ? req.body.appId.trim() : "";
  const hooks = appId
    ? [await store.getGithubAppHook(client.accountId, appId)].filter(Boolean as unknown as (h: unknown) => boolean)
    : await store.listGithubAppHooks(client.accountId);
  const targets = hooks as Array<{ id: string }>;
  if (!targets.length) return res.status(404).json({ error: "No GitHub App connected" });
  let updated: { triggerAccess?: string } | undefined;
  for (const target of targets) {
    updated = (await store.setInboundHookTriggerAccess(client.accountId, target.id, triggerAccess)) ?? updated;
  }
  res.json({ ok: true, triggerAccess: updated?.triggerAccess ?? "everyone" });
}));

// Disconnect the account's GitHub App: drop the inbound hook so it stops routing
// and the UI no longer shows it as connected. The node clears its own copy of the
// key separately (github.app.disconnect). Idempotent — ok if nothing is connected.
app.delete("/account/github-app", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  // Scope precedence: by app id, else by a single hook id (a stale app from an
  // abandoned create flow has a hook but no App ID — it must be removable on its
  // own without taking the account's healthy apps with it). Only with NEITHER do
  // ALL github_app hooks go — orphans included — since deleting just the newest
  // would let one resurface as "connected".
  const appId = typeof req.query.appId === "string" ? req.query.appId.trim() : "";
  const hookId = typeof req.query.hookId === "string" ? req.query.hookId.trim() : "";
  const removed = appId
    ? await store.deleteGithubAppHooksForApp(client.accountId, appId)
    : hookId
      ? (await store.deleteInboundHook(client.accountId, hookId)) ? 1 : 0
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
    triggerId: w.triggerId,
    triggerKind: w.triggerKind,
    definitionId: w.definitionId,
    attempt: w.attempt,
    targetKind: w.targetKind,
    startedAt: w.startedAt,
    output: w.output,
    approvalMode: w.approvalMode,
    sandbox: w.sandbox,
    // Privacy-safe run evidence (issue #153): why this node/runtime was picked,
    // declared-check pass/fail/exit status, and a bounded event timeline. Never
    // a prompt, transcript, diff, file content, secret, token, or raw command/
    // tool output — see run-evidence.ts, which is the only thing that ever
    // writes to these three fields.
    routingReason: w.routingReason,
    checks: w.checks,
    events: w.events,
  })));
}));

// Trigger-neutral automation API. The work-item endpoints below remain
// compatibility adapters over these same rows.
app.get("/account/automations", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  res.json(await store.listAutomationDefinitions(client.accountId));
}));

app.post("/account/automations", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  let schedule;
  try {
    schedule = normalizeSchedule(req.body?.schedule);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  const enabled = req.body?.enabled !== false;
  const nextRunAt = enabled ? nextOccurrence(schedule, new Date(Date.now() - 1)) : undefined;
  if (enabled && !nextRunAt) return res.status(400).json({ error: "The one-time timestamp must be in the future." });
  const definition = await store.createAutomationDefinition(client.accountId, {
    name,
    templateCiphertext: typeof req.body?.templateCiphertext === "string" ? req.body.templateCiphertext : undefined,
    runtimeId: typeof req.body?.runtimeId === "string" ? req.body.runtimeId : undefined,
    model: typeof req.body?.model === "string" ? req.body.model : undefined,
    nodeLabel: typeof req.body?.nodeLabel === "string" ? req.body.nodeLabel : undefined,
    ephemeral: typeof req.body?.ephemeral === "boolean" ? req.body.ephemeral : undefined,
    approvalMode: ["never", "risky", "always", "autonomous"].includes(req.body?.approvalMode) ? req.body.approvalMode : undefined,
    sandbox: ["read-only", "workspace-write", "danger-full-access"].includes(req.body?.sandbox) ? req.body.sandbox : undefined,
    enabled,
    schedule,
    nextRunAt,
  });
  res.status(201).json(definition);
}));

app.put("/account/automations/:id", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const current = await store.getAutomationDefinition(client.accountId, String(req.params.id));
  if (!current) return res.status(404).json({ error: "Automation not found" });
  let schedule = current.schedule;
  if (req.body?.schedule !== undefined) {
    try {
      schedule = normalizeSchedule(req.body.schedule);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }
  if (!schedule) return res.status(400).json({ error: "schedule is required" });
  const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : current.enabled;
  const scheduleChanged = req.body?.schedule !== undefined;
  // Recompute the occurrence when (re-)enabling or when the schedule changed;
  // otherwise keep the current occurrence (or clear it while disabled).
  const recompute = enabled && (scheduleChanged || !current.enabled);
  const nextRunAt = recompute
    ? nextOccurrence(schedule, new Date(Date.now() - 1))
    : enabled ? current.nextRunAt : undefined;
  // Mirror the create-time guard: an enabled definition whose only occurrence is
  // in the past would sit enabled but never run.
  if (recompute && !nextRunAt) return res.status(400).json({ error: "The one-time timestamp must be in the future." });
  const patch = {
    name: typeof req.body?.name === "string" ? req.body.name.trim() || current.name : current.name,
    templateCiphertext: typeof req.body?.templateCiphertext === "string" ? req.body.templateCiphertext : current.templateCiphertext,
    runtimeId: typeof req.body?.runtimeId === "string" ? req.body.runtimeId.trim() || undefined : current.runtimeId,
    model: typeof req.body?.model === "string" ? req.body.model.trim() || undefined : current.model,
    nodeLabel: typeof req.body?.nodeLabel === "string" ? req.body.nodeLabel.trim() || undefined : current.nodeLabel,
    approvalMode: ["never", "risky", "always", "autonomous"].includes(req.body?.approvalMode) ? req.body.approvalMode : current.approvalMode,
    sandbox: ["read-only", "workspace-write", "danger-full-access"].includes(req.body?.sandbox) ? req.body.sandbox : current.sandbox,
    enabled,
    schedule,
    nextRunAt,
  };
  res.json(await store.updateAutomationDefinition(client.accountId, current.id, patch));
}));

app.delete("/account/automations/:id", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  if (!(await store.deleteAutomationDefinition(client.accountId, String(req.params.id)))) {
    return res.status(404).json({ error: "Automation not found" });
  }
  res.status(204).end();
}));

app.post("/account/automations/:id/run", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const definition = await store.getAutomationDefinition(client.accountId, String(req.params.id));
  if (!definition) return res.status(404).json({ error: "Automation not found" });
  const run = await store.enqueueAutomationRun(client.accountId, {
    source: "manual",
    triggerKind: "manual",
    title: definition.name,
    body: definition.templateCiphertext,
    definitionId: definition.id,
    label: definition.nodeLabel,
  });
  void notifyRelaysWorkAvailable(client.accountId, { id: run.id, label: run.routing.nodeLabel });
  res.status(201).json(run);
}));

app.get("/account/automation-runs", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  res.json(await store.listAutomationRuns(client.accountId, Number(req.query.limit) || 50));
}));

app.get("/account/automation-triggers", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  res.json(await store.listTriggerEvents(client.accountId, Number(req.query.limit) || 50));
}));

app.post("/account/automation-runs", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "title is required" });
  const run = await store.enqueueAutomationRun(client.accountId, {
    source: "manual",
    triggerKind: "manual",
    title,
    label: typeof req.body?.label === "string" ? req.body.label : undefined,
    definitionId: typeof req.body?.definitionId === "string" ? req.body.definitionId : undefined,
    dedupeKey: typeof req.body?.sourceKey === "string" ? req.body.sourceKey : undefined,
    runtimeId: typeof req.body?.runtimeId === "string" ? req.body.runtimeId : undefined,
    model: typeof req.body?.model === "string" ? req.body.model : undefined,
  });
  res.status(201).json(run);
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

// Account-level ephemeral node configs (reusable runner templates). CRUD via
// read-modify-write of the JSONB array — low write frequency, so no locking.
app.get("/account/ephemeral-configs", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  res.json(await store.getEphemeralConfigs(client.accountId));
}));

app.post("/account/ephemeral-configs", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  if (!name) return res.status(400).json({ error: "Config name is required" });
  if (!provider) return res.status(400).json({ error: "Provider is required" });
  const now = new Date().toISOString();
  const config: EphemeralNodeConfig = {
    id: `cfg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name, provider, createdAt: now, updatedAt: now,
  };
  if (typeof body.region === "string" && body.region.trim()) config.region = body.region.trim();
  if (typeof body.size === "string" && body.size.trim()) config.size = body.size.trim();
  if (typeof body.ttlMinutes === "number") config.ttlMinutes = body.ttlMinutes;
  if (body.teardownOnAgentFinish === true) config.teardownOnAgentFinish = true;
  const current = await store.getEphemeralConfigs(client.accountId);
  const saved = await store.setEphemeralConfigs(client.accountId, [...current, config]);
  res.json(saved.find((c) => c.id === config.id) ?? config);
}));

app.put("/account/ephemeral-configs/:id", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const id = String(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const current = await store.getEphemeralConfigs(client.accountId);
  const existing = current.find((c) => c.id === id);
  if (!existing) return res.status(404).json({ error: "Config not found" });
  const next: EphemeralNodeConfig = { ...existing, updatedAt: new Date().toISOString() };
  if (typeof body.name === "string" && body.name.trim()) next.name = body.name.trim();
  if (typeof body.provider === "string" && body.provider.trim()) next.provider = body.provider.trim();
  if (typeof body.region === "string") next.region = body.region.trim() || undefined;
  if (typeof body.size === "string") next.size = body.size.trim() || undefined;
  if (typeof body.ttlMinutes === "number") next.ttlMinutes = body.ttlMinutes;
  if (typeof body.teardownOnAgentFinish === "boolean") next.teardownOnAgentFinish = body.teardownOnAgentFinish || undefined;
  const saved = await store.setEphemeralConfigs(client.accountId, current.map((c) => (c.id === id ? next : c)));
  res.json(saved.find((c) => c.id === id) ?? next);
}));

app.delete("/account/ephemeral-configs/:id", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const id = String(req.params.id);
  const current = await store.getEphemeralConfigs(client.accountId);
  const saved = await store.setEphemeralConfigs(client.accountId, current.filter((c) => c.id !== id));
  res.json({ ok: true, configs: saved });
}));

app.get("/account/queue-routing", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  res.json(await store.getQueueRouting(client.accountId));
}));

app.put("/account/queue-routing", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  res.json(await store.setQueueRouting(client.accountId, (req.body ?? {}) as QueueRouting));
}));

// Hosted (control-plane-orchestrated) provisioning. GET returns a redacted
// status (never tokens). SECURITY: enabling this stores repo/cloud credentials
// on the control plane — see store.ts.
app.get("/account/hosted-provisioning", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const status = await store.getHostedProvisioningStatus(client.accountId);
  res.json({ ...status, encryptionReady: hostedEncryptionAvailable(), keyId: hostedPrimaryKid() });
}));

app.put("/account/hosted-provisioning", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Fail closed: never accept secrets to store unless encryption is configured.
  const providerTokens = body.providerTokens as Record<string, unknown> | undefined;
  const settingSecret =
    (typeof body.githubToken === "string" && body.githubToken.trim() !== "")
    || (providerTokens && typeof providerTokens === "object" && Object.values(providerTokens).some((v) => typeof v === "string" && v))
    || (body.githubApp != null && typeof body.githubApp === "object");
  if (settingSecret && !hostedEncryptionAvailable()) {
    return res.status(503).json({ error: "Credential encryption is not configured (set HOSTED_CREDENTIAL_KEY). Refusing to store secrets in plaintext." });
  }
  const patch: Partial<HostedProvisioning> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.githubToken === "string") patch.githubToken = body.githubToken;
  if (body.githubApp != null && typeof body.githubApp === "object") patch.githubApp = body.githubApp as HostedProvisioning["githubApp"];
  if (providerTokens && typeof providerTokens === "object") patch.providerTokens = providerTokens as Record<string, string>;
  await store.setHostedProvisioning(client.accountId, patch);
  await store.appendHostedAudit(client.accountId, { at: new Date().toISOString(), action: "credential_updated", detail: Object.keys(patch).join(",") || "none" });
  const status = await store.getHostedProvisioningStatus(client.accountId);
  res.json({ ...status, encryptionReady: hostedEncryptionAvailable(), keyId: hostedPrimaryKid() });
}));

// Audit trail of hosted-credential use (never contains secrets).
app.get("/account/hosted-audit", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  res.json(await store.listHostedAudit(client.accountId, 50));
}));

// Re-seal this account's hosted credentials under the current primary key
// (key rotation): a decrypt-with-old-kid + encrypt-with-primary round-trip.
app.post("/account/hosted-provisioning/rotate", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  if (!hostedEncryptionAvailable()) return res.status(503).json({ error: "No encryption key configured" });
  await store.setHostedProvisioning(client.accountId, {}); // re-encrypts under the primary key
  await store.appendHostedAudit(client.accountId, { at: new Date().toISOString(), action: "credential_rotated", detail: `kid ${hostedPrimaryKid() ?? ""}` });
  const status = await store.getHostedProvisioningStatus(client.accountId);
  res.json({ ...status, encryptionReady: hostedEncryptionAvailable(), keyId: hostedPrimaryKid() });
}));

// Inspect or trigger the provisioning decision. Dry-run by default (returns the
// plan); pass { execute: true } to actually launch when the plan says so.
app.post("/account/hosted-provision-now", asyncHandler(async (req, res) => {
  const client = await store.resolveClient(bearer(req));
  if (!client) return res.status(401).json({ error: "Unauthorized" });
  const plan = await planAutoProvision(store, client.accountId);
  if (req.body?.execute === true && plan.willProvision) {
    const machine = await maybeAutoProvision(store, client.accountId, provisionEnv());
    return res.json({ plan, provisioned: machine ? { id: machine.id, nodeId: machine.nodeId } : null });
  }
  res.json({ plan });
}));

// Mint-on-demand: a hosted machine's git credential helper fetches a fresh
// installation token per git op (so long sessions never hold a stale/long-lived
// token). Authenticated by the node's enrollment token.
app.post("/node/hosted-git-credential", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const minted = await mintHostedInstallationToken(store, node.accountId);
  if (!minted) return res.status(404).json({ error: "No hosted GitHub App configured" });
  res.json({ token: minted.token, expiresAt: minted.expiresAt });
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
const automationRateWindows = new Map<string, { startedAt: number; count: number }>();
function consumeAutomationRate(key: string, limit: number, now = Date.now()): boolean {
  const current = automationRateWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    automationRateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

app.post("/webhooks/automation/:id", asyncHandler(async (req, res) => {
  const hook = await store.getInboundHook(String(req.params.id));
  if (!hook || hook.kind !== "automation") return res.status(404).json({ code: "not_found" });
  if (hook.enabled === false) return res.status(410).json({ code: "disabled" });
  if (!consumeAutomationRate(`hook:${hook.id}`, 60)) {
    return res.status(429).json({ code: "quota_exhausted", retryAfterSeconds: 60 });
  }
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verifyAutomationSignature(hook.secret, raw, req.headers["x-bivy-signature-256"] as string | undefined)) {
    return res.status(401).json({ code: "invalid_signature" });
  }
  if (!consumeAutomationRate(`account:${hook.accountId}`, 300)) {
    return res.status(429).json({ code: "quota_exhausted", retryAfterSeconds: 60 });
  }
  const idempotencyKey = String(req.headers["x-bivy-idempotency-key"] ?? "").trim();
  if (!idempotencyKey || idempotencyKey.length > 200 || /[^\x21-\x7e]/.test(idempotencyKey)) {
    return res.status(400).json({ code: "invalid_request", error: "A valid X-Bivy-Idempotency-Key header is required." });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ code: "invalid_request", error: "Invalid JSON." });
  }
  const event = parseAutomationEvent(payload);
  if (!event || !hook.templateInstruction) {
    return res.status(400).json({ code: "invalid_request", error: "Event does not match automation schema version 1." });
  }
  const dedupeKey = `automation:${hook.id}:${idempotencyKey}`;
  const replay = await store.getAutomationRunBySourceKey(hook.accountId, dedupeKey);
  if (replay) return res.status(200).json({ code: "duplicate", id: replay.id });
  const entitlements = await store.entitlements(hook.accountId);
  if (!entitlements.workQueueEnabled) return res.status(429).json({ code: "quota_exhausted" });
  const allowance = await runAllowance(hook.accountId);
  if (allowance.exhausted) {
    recordFunnelEvent("quota_blocked", "automation", entitlements.plan);
    return res.status(429).json({ code: "quota_exhausted", limit: allowance.limit, used: allowance.used });
  }
  const route = event.routing || hook.routingDefault;
  const label = route ? `bivy/${route}` : "bivy";
  const result = await store.enqueueAutomationRunWithResult(hook.accountId, {
    label,
    source: `automation:${hook.id}`,
    triggerKind: "webhook",
    title: event.title || event.instruction.slice(0, 200),
    body: renderAutomationInstruction(hook.templateInstruction, event),
    url: event.sourceUrl,
    externalId: event.externalId,
    dedupeKey,
    defaultRouted: !route,
  });
  if (!result.created) {
    return res.status(200).json({ code: "duplicate", id: result.run.id });
  }
  void notifyRelaysWorkAvailable(hook.accountId, {
    id: result.run.id,
    label: result.run.routing.nodeLabel,
  });
  res.status(202).json({ code: "accepted", id: result.run.id, label });
}));

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
  // claim time against the rolling cap, see runAllowance), so this only refuses a
  // plan that has the feature fully off. Ack with 200 so GitHub marks the delivery
  // successful (a non-2xx would make GitHub retry forever) but enqueue nothing.
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
    // Issue #259: on a public repo, anyone can `@`-mention the bot in a comment —
    // gate on the commenter's GitHub `author_association` per the account's
    // configured access level (Settings → GitHub App). Ack 200 so GitHub doesn't
    // retry; just enqueue nothing.
    if (!meetsTriggerAccess(comment.authorAssociation, hook.triggerAccess)) {
      return res.json({ ok: true, enqueued: false, reason: "access" });
    }
    const rawLabel = pickCommentRoutingLabel(comment.instruction, comment.issueLabels, triggerLogin);
    const label = applyDefaultNode(rawLabel, hook.defaultNode);
    const item = await store.enqueueWorkItem(hook.accountId, {
      label,
      source: "github:comment",
      // Issue #153: the control plane no longer retains issue/comment title or
      // body — the claiming node fetches the live comment directly from GitHub
      // (see getIssueCommentBody in src/github-tasks.ts) immediately before use.
      title: `GitHub issue #${comment.issueNumber}`,
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
  // Issue #259: a `bivy`/`bivy/<node>` LABEL already implies collaborator/triage
  // access (GitHub itself restricts who can apply a label), so only the body-
  // mention path — anyone can open an issue on a public repo — needs gating on
  // the author's `author_association`.
  const isLabelRouted = Boolean(pickRoutingLabel(issue.labels));
  if (!isLabelRouted && !meetsTriggerAccess(issue.authorAssociation, hook.triggerAccess)) {
    return res.json({ ok: true, enqueued: false, reason: "access" });
  }
  const item = await store.enqueueWorkItem(hook.accountId, {
    label,
    source: "github:issue",
    // Issue #153: the control plane no longer retains issue title/body — the
    // claiming node fetches the live issue directly from GitHub (getIssue in
    // src/github-tasks.ts) immediately before use.
    title: `GitHub issue #${issue.issueNumber}`,
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

// Linear Issue webhook. Applying `bivy` or `bivy/<node>` dispatches the issue.
// Only identifiers/routing metadata are retained; the claiming node retrieves
// title/description directly from Linear with BIVY_LINEAR_API_KEY.
app.post("/webhooks/linear/:id", asyncHandler(async (req, res) => {
  const hook = await store.getInboundHook(String(req.params.id));
  if (!hook || hook.kind !== "linear") return res.status(404).json({ error: "Unknown hook" });
  if (hook.enabled === false) return res.status(410).json({ error: "Linear integration is not configured" });
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verifyLinearSignature(hook.secret, raw, req.headers["linear-signature"] as string | undefined)) {
    return res.status(401).json({ error: "Bad signature" });
  }
  if (!(await store.entitlements(hook.accountId)).workQueueEnabled) {
    return res.json({ ok: true, enqueued: false, reason: "plan" });
  }
  let payload: unknown;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  const issue = parseLinearIssueEvent(payload);
  if (!issue) return res.json({ ok: true, enqueued: false });
  const rawLabel = pickRoutingLabel(issue.labels);
  if (!rawLabel) return res.json({ ok: true, enqueued: false });
  const label = applyDefaultNode(rawLabel, hook.defaultNode);
  const deliveryId = String(req.headers["linear-delivery"] ?? "").trim();
  const item = await store.enqueueWorkItem(hook.accountId, {
    label,
    source: "linear:issue",
    title: `Linear issue ${issue.identifier}`,
    repo: issue.repo,
    externalId: issue.id,
    url: issue.url,
    dedupeKey: deliveryId ? `linear:${deliveryId}` : undefined,
    collapseKey: `linear-issue:${issue.id}`,
    defaultRouted: rawLabel === "bivy",
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
  if (hook.enabled === false) return res.status(410).json({ error: "Slack integration disabled" });
  const form = new URLSearchParams(raw.toString("utf8"));
  const { node, repo, prompt } = parseSlackCommand(form.get("text") ?? "");
  if (!prompt) return res.json({ response_type: "ephemeral", text: "Usage: /bivy [on <node>] [in <owner/repo>] <what to do>" });
  const rawLabel = node ? `bivy/${node}` : "bivy";
  const label = applyDefaultNode(rawLabel, hook.defaultNode);
  const triggerId = form.get("trigger_id") || undefined;
  const item = await store.enqueueWorkItem(hook.accountId, {
    label,
    source: "slack",
    title: prompt,
    repo,
    dedupeKey: triggerId ? `slack:${triggerId}` : undefined,
    defaultRouted: !node,
  });
  void notifyRelaysWorkAvailable(hook.accountId, item);
  const destination = repo ? `${repo} on ${label}` : label;
  res.json({ response_type: "ephemeral", text: `On it — queued for ${destination}.${repo ? " I'll bring back a pull request." : ""}` });
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
  // Free-tier rolling automation quota: once the queued-job allowance is spent,
  // hide pending items so the node stops trying to claim them. They stay
  // queued and become visible again as capacity ages back in (no data lost, no
  // churn). The claim endpoint below is the authoritative backstop for a direct/racing claim.
  if ((await runAllowance(node.accountId)).exhausted) return res.json({ items: [] });
  res.json({ items });
}));

// Claim one item (atomic; only one node wins). Returns the item or 409 if taken.
app.post("/node/work/:id/claim", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  // Authoritative free-tier quota gate for unattended automation. Interactive
  // sessions never reach this endpoint and never consume the allowance.
  // 402 (not 409) so the node can tell "you're out of runs" from "someone else won
  // this item". Only bites under ENFORCE_ENTITLEMENTS; self-host is unlimited.
  const allowance = await runAllowance(node.accountId);
  if (allowance.exhausted) {
    recordFunnelEvent("quota_blocked", "work_queue", (await store.entitlements(node.accountId)).plan);
    return res.status(402).json({ error: "Weekly automation limit reached for your plan.", reason: "quota", limit: allowance.limit, used: allowance.used });
  }
  const item = await store.claimWorkItem(node.accountId, node.id, String(req.params.id));
  if (!item) return res.status(409).json({ error: "Already claimed or unknown" });
  res.json({ ok: true, item });
}));

app.post("/node/work/:id/complete", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const id = String(req.params.id);
  const current = await store.getAutomationRun(node.accountId, id);
  if (!current || current.claimedByNodeId !== node.id) {
    return res.status(409).json({ error: "Run is not owned by this node" });
  }
  await store.completeWorkItem(node.accountId, id);
  // Compatibility for older nodes that skip the explicit /running transition.
  const started = await store.recordRunStart(node.accountId, `automation:${id}`);
  if (started) recordFunnelEvent("run_started", "automation", (await store.entitlements(node.accountId)).plan);
  res.json({ ok: true });
}));

app.post("/node/work/:id/running", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const id = String(req.params.id);
  const current = await store.getAutomationRun(node.accountId, id);
  if (!current || current.claimedByNodeId !== node.id || current.status !== "claimed") {
    return res.status(409).json({ error: "Run is not claimed by this node" });
  }
  const run = await store.transitionAutomationRun(node.accountId, id, "running");
  const started = await store.recordRunStart(node.accountId, `automation:${id}`);
  if (started) recordFunnelEvent("run_started", "automation", (await store.entitlements(node.accountId)).plan);
  res.json({ ok: true, run });
}));

app.post("/node/work/:id/fail", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const id = String(req.params.id);
  const current = await store.getAutomationRun(node.accountId, id);
  if (!current || current.claimedByNodeId !== node.id) {
    return res.status(409).json({ error: "Run is not owned by this node" });
  }
  const run = await store.transitionAutomationRun(node.accountId, id, "failed");
  if (!run) return res.status(404).json({ error: "Unknown run" });
  res.json({ ok: true, run });
}));

// Park a claimed run for a human: the node's run policy exhausted its automatic
// recovery (quota/auth/context, or a drained fallback chain) and wants the run
// surfaced rather than silently failed. Transitions running/claimed →
// needs_attention (which auto-stamps a `needs_attention` timeline event). The
// node should first POST the reason as a bounded evidence event.
app.post("/node/work/:id/needs-attention", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const id = String(req.params.id);
  const current = await store.getAutomationRun(node.accountId, id);
  if (!current || current.claimedByNodeId !== node.id) {
    return res.status(409).json({ error: "Run is not owned by this node" });
  }
  const run = await store.transitionAutomationRun(node.accountId, id, "needs_attention");
  if (!run) return res.status(404).json({ error: "Unknown run" });
  res.json({ ok: true, run });
}));

// Privacy-safe run evidence (issue #153): the node that claimed a run may
// report why it routed the way it did, output references (branch/PR/
// checkpoint/commit/...), declared-check results, and new timeline events
// (routing changes, retries/fallback, approvals, policy denials, ...).
// sanitizeEvidencePatch is the ONLY thing standing between an arbitrary node
// payload and storage — it allowlists every field and rejects anything that
// looks like a prompt, transcript, diff, file content, secret, token, or raw
// command/tool output outright (400, not a silent drop).
app.post("/node/work/:id/evidence", requireNode, asyncHandler(async (req, res) => {
  const node = (req as Request & { node: NodeRecord }).node;
  const id = String(req.params.id);
  const current = await store.getAutomationRun(node.accountId, id);
  if (!current || current.claimedByNodeId !== node.id) {
    return res.status(409).json({ error: "Run is not owned by this node" });
  }
  let patch;
  try {
    patch = sanitizeEvidencePatch(req.body);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  const run = await store.appendRunEvidence(node.accountId, id, patch);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  res.json({ ok: true, run });
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
  // Transient CLI/relay clients (`bivy run --node`, sibling replicas, probes)
  // pair the same way a phone/browser does, but they are short-lived tool
  // connections — not user devices. Registering them as paired devices spams
  // the account's "Signed-in devices" list (each fresh keypair = a new row) and
  // never gets cleaned up. When the node marks the pairing ephemeral, authorize
  // it (deliver the room key) but skip the durable device record.
  const ephemeral = req.body?.ephemeral === true;
  const devicePublicKeyB64 = String(req.body?.devicePublicKeyB64 ?? "").trim();
  if (devicePublicKeyB64 && !ephemeral) {
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

// --- Billing ------------------------------------------------------------

// Public plan prices are read from the configured Stripe Price objects rather
// than duplicated in clients or the marketing site. The short cache avoids a
// Stripe API request on every page load while still reflecting dashboard changes.
app.get("/billing/plans", asyncHandler(async (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.MARKETING_SITE_URL ?? "https://bivy.sh");
  res.json({ plans: await publicPlanPrices() });
}));

app.post("/billing/checkout", requireUser, asyncHandler(async (req, res) => {
  const account = (req as Request & { account: Account }).account;
  const plan = normalizePlan(String(req.body?.plan ?? "pro")) as Plan;
  if (plan !== "pro" && !(plan === "team" && stripePrices.team)) return res.status(400).json({ error: "Invalid plan" });

  if (!stripe) {
    if (process.env.NODE_ENV === "production") throw new Error("STRIPE_SECRET_KEY is required for production checkout");
    recordFunnelEvent("checkout_started", plan, account.plan);
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
  recordFunnelEvent("checkout_started", plan, account.plan);
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
    if (accountId && ["free", "pro", "team"].includes(plan)) {
      const previous = await store.getAccount(accountId);
      await store.setPlan(accountId, plan, body?.stripeCustomerId);
      if (previous && previous.plan !== plan) recordFunnelEvent("plan_changed", "dev_webhook", plan);
    }
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
      if (account.plan !== nextPlan) recordFunnelEvent("plan_changed", "stripe_subscription", nextPlan);
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
      if (account.plan !== "free") recordFunnelEvent("plan_changed", "stripe_deleted", "free");
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
  if (status === 413 && req.path.startsWith("/webhooks/automation/")) {
    return res.status(413).json({ code: "payload_too_large" });
  }
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
    Sentry.captureException(error);
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
