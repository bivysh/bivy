// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import {
  type Account,
  type DeviceLoginStatus,
  type Entitlements,
  type MeshStore,
  type NodeRecord,
  type NodeProviderSummary,
  type PairedDeviceInfo,
  type Plan,
  type RelayRole,
  type RelayTicket,
  type ResolvedClient,
  type SessionAdvert,
  type SessionIndexEntry,
  type SessionOwnership,
  type PushSubscriptionRecord,
  type NotificationPreferences,
  normalizeNotificationPreferences,
  type EphemeralQueueDefault,
  normalizeEphemeralQueueDefault,
  type ModelAuthVault,
  type ModelAuthWrappedKey,
  type ModelAuthKeyRequest,
  type SubscriptionState,
  type InboundHook,
  type UsageMetrics,
  type WorkItem,
  type WorkItemInput,
  entitlementsForPlan,
  hashToken,
  disambiguateNodeName,
  cleanNodeName,
  normalizeWorkLabel,
  clampInstallCount,
  LOGIN_TOKEN_TTL_MS,
  SESSION_TTL_MS,
} from "./store.js";

/**
 * The control plane's single store implementation, backed by Postgres — a durable
 * database when `DATABASE_URL` is set, or an in-memory Postgres (pg-mem) for
 * dev/tests otherwise (see pg-mem-store.ts). Both go through `createStore()`
 * (store-factory.ts), so there is no second hand-mirrored implementation.
 *
 * Same hard rule as the rest of the control plane:
 * stores ONLY metadata for sessions/work. Never session content, files, prompts,
 * or tool output. Model provider credentials are the explicit account-vault
 * exception for cross-node model auth. All bearer tokens are stored hashed
 * (SHA-256); raw tokens are returned to the caller exactly once at creation.
 */
export class PostgresStore implements MeshStore {
  private pool: pg.Pool;

  // `pool` is an optional injection seam: production passes only a
  // connectionString and we build a real pg.Pool; tests can hand in an
  // already-constructed Pool (e.g. pg-mem's `db.adapters.createPg().Pool`) to run
  // the shared store contract against this exact class with no real database.
  // See test/store-contract.test.ts for the pg-mem wiring.
  constructor(connectionString: string, pool?: pg.Pool) {
    // Pool size is configurable so the control plane can absorb reconnect
    // storms (e.g. a relay-fleet restart fires ~one introspection query per
    // node, all at once). The pg default of 10 queues hard under that burst.
    // When running multiple control-plane instances, keep total connections
    // (instances x DATABASE_POOL_MAX) under Postgres `max_connections`, or
    // front Postgres with PgBouncer (see docs/scaling.md).
    const max = Math.max(Number(process.env.DATABASE_POOL_MAX) || 10, 1);
    this.pool = pool ?? new pg.Pool({ connectionString, max });
    // A pg.Pool emits 'error' when an *idle* pooled connection fails on its own
    // — the managed database reaping idle connections, a failover/restart, or a
    // network blip. node-postgres requires a listener here: with none attached,
    // that idle-client error escalates to an uncaught exception and takes the
    // whole process down. A crashed control plane means every request (including
    // POST /client/relay-ticket) returns 502 Bad Gateway until the container
    // restarts — the exact intermittent-502 symptom this guards against. The pool
    // discards the dead connection and reconnects on the next query, so logging
    // (not crashing) is the correct response.
    this.pool.on("error", (err) => {
      console.error("Postgres idle client error (pool will reconnect):", err.message);
    });
  }

  // Errors that happen while *establishing* a connection — before any SQL is
  // sent — so the query provably never ran and retrying is safe. A transient DNS
  // hiccup (getaddrinfo EAI_AGAIN, the exact error that turned relay-ticket mint
  // and GitHub sign-in into intermittent 500s), a refused connection during a
  // database restart/failover, or an unresolved host all land here. We
  // deliberately exclude mid-query drops (ECONNRESET / "Connection terminated"):
  // those can leave a non-idempotent write half-applied, so we surface them
  // rather than risk double-applying.
  private static readonly RETRYABLE_CONNECT_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"]);

  private isRetryable(err: unknown): boolean {
    const code = (err as { code?: string })?.code;
    return typeof code === "string" && PostgresStore.RETRYABLE_CONNECT_CODES.has(code);
  }

  // Run a pooled query, retrying a couple of times with backoff when the pool
  // fails to reach Postgres at connect time. Turns a brief network/DNS blip into
  // a successful request instead of a user-facing 500.
  private async query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
    const maxRetries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.pool.query(text, params as unknown[] | undefined);
      } catch (err) {
        if (attempt >= maxRetries || !this.isRetryable(err)) throw err;
        const backoffMs = 100 * 2 ** attempt;
        console.warn(`Postgres connect error (retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms):`, (err as Error).message);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  async init() {
    await this.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id                  TEXT PRIMARY KEY,
        email               TEXT UNIQUE NOT NULL,
        plan                TEXT NOT NULL DEFAULT 'free',
        stripe_customer_id  TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Subscription metadata (added after initial release; ADD COLUMN IF NOT
      -- EXISTS keeps this a safe, idempotent migration on existing databases).
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS subscription_status     TEXT;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS plan_updated_at         TIMESTAMPTZ;
      -- Per-account push notification preferences ({ [kind]: boolean }). NULL =
      -- "no preferences saved yet" and reads back as all-enabled defaults.
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS notification_preferences JSONB;
      -- Ephemeral-queue-default preference (issue #532): whether/how a signed-in
      -- device should auto-provision an ephemeral runner for the GitHub work
      -- queue when no persistent node is online. NULL = disabled (never set).
      -- Non-secret preferences only — see EphemeralQueueDefault in store.ts.
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ephemeral_queue_default JSONB;
      -- The paid single-user plan was renamed 'individual' -> 'pro' to match what
      -- it is sold as. The plan column is plain TEXT with no enum or CHECK, so the
      -- backfill is a straight UPDATE; it is idempotent (the second run matches no
      -- rows) and runs before the process serves traffic, so no request can observe
      -- the old id. Stripe subscription metadata cannot be backfilled this way and
      -- is normalized on read instead — see planFromSubscription in index.ts.
      UPDATE accounts SET plan = 'pro' WHERE plan = 'individual';

      CREATE TABLE IF NOT EXISTS login_tokens (
        token_hash  TEXT PRIMARY KEY,
        email       TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash  TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at  TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS link_grants (
        token_hash  TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        node_id     TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relay_tickets (
        token_hash  TEXT PRIMARY KEY,
        role        TEXT NOT NULL,
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        node_id     TEXT,
        expires_at  TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS device_logins (
        device_id    TEXT PRIMARY KEY,
        secret_hash  TEXT NOT NULL,
        account_id   TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at   TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paired_devices (
        public_key_b64  TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        label           TEXT NOT NULL,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id                     TEXT PRIMARY KEY,
        account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name                   TEXT NOT NULL,
        enrollment_token_hash  TEXT NOT NULL,
        online                 BOOLEAN NOT NULL DEFAULT false,
        last_seen_at           TIMESTAMPTZ,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Plaintext (non-secret) per-node provider connection summary — pushed by
      -- the owning node alongside its encrypted model-auth vault. Same trust
      -- tier as online/last_seen_at above: never credential material.
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS providers JSONB;

      CREATE TABLE IF NOT EXISTS session_index (
        node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL,
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        status      TEXT NOT NULL,
        source      TEXT,
        title_enc   TEXT,
        branch      TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (node_id, session_id)
      );

      -- Stage 2 (docs/agent-node-decoupling.md): the agent-service address that
      -- hosts a session's live runtime, so any daemon can re-attach by looking it
      -- up. Routing metadata like node_id, not E2E payload. ADD COLUMN IF NOT
      -- EXISTS keeps this a safe, idempotent migration on existing databases.
      ALTER TABLE session_index ADD COLUMN IF NOT EXISTS agent_service_address TEXT;

      -- Session replication ownership (docs/session-replication.md). Keyed by
      -- session, NOT node, so it survives the wholesale rewrite of session_index
      -- on every advertise. owner_epoch is the promotion fence (compare-and-set).
      CREATE TABLE IF NOT EXISTS session_ownership (
        account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        session_id      TEXT NOT NULL,
        owner_node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        standby_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
        owner_epoch     INTEGER NOT NULL DEFAULT 0,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        endpoint      TEXT PRIMARY KEY,
        subscription  JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Remove the earlier plaintext snapshot table if an intermediate build ever
      -- created it. The E2E vault below is the only supported model-auth store.
      DROP TABLE IF EXISTS model_auth_snapshots;

      CREATE TABLE IF NOT EXISTS model_auth_vaults (
        account_id          TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        ciphertext          TEXT NOT NULL,
        updated_by_node_id  TEXT NOT NULL,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS model_auth_node_keys (
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        public_key  TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, node_id)
      );

      CREATE TABLE IF NOT EXISTS model_auth_wrapped_keys (
        account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        node_id             TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        wrapped_key            TEXT NOT NULL,
        wrapped_by_node_id     TEXT NOT NULL,
        wrapped_by_public_key  TEXT NOT NULL DEFAULT '',
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, node_id)
      );
      ALTER TABLE model_auth_wrapped_keys ADD COLUMN IF NOT EXISTS wrapped_by_public_key TEXT NOT NULL DEFAULT '';

      CREATE TABLE IF NOT EXISTS model_auth_key_requests (
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        public_key  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, node_id)
      );

      -- Inbound hooks (route a GitHub/Slack webhook to an account) + work queue
      -- (E2/E4). The control plane only routes metadata; the node pulls items and
      -- runs them with its own token.
      CREATE TABLE IF NOT EXISTS inbound_hooks (
        id          TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        secret      TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- GitHub App display/routing metadata registered by the node (flavor A):
      -- the app slug doubles as the unique at-mention handle, plus its name.
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS bot_mention TEXT;
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS app_name    TEXT;
      -- The GitHub App's numeric App ID (display/pre-fill only, not a credential).
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS app_id      TEXT;
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS app_owner      TEXT;
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS app_owner_type TEXT;
      -- How many repos/orgs the GitHub App is installed on, reported by the node
      -- (which holds the key). NULL = never synced. Drives the "not installed
      -- yet" warning, since the app is inert until installed somewhere.
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS install_count      INTEGER;
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS installs_synced_at TIMESTAMPTZ;
      -- The node-label suffix (e.g. "macbook") that untagged/generic 'bivy'-routed
      -- work should default to, so it deterministically lands on one node instead
      -- of racing across every node serving the shared label. Settings -> GitHub App.
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS default_node TEXT;
      -- The node currently holding this GitHub App's key and servicing it. Cleared
      -- when that node is removed, so the UI shows "no node serving" instead of a
      -- stale "connected" after a node delete/reinstall.
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS serving_node_id      TEXT;
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS serving_node_seen_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS work_items (
        id                 TEXT PRIMARY KEY,
        account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        label              TEXT NOT NULL DEFAULT 'bivy',
        source             TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending',
        title              TEXT NOT NULL,
        body               TEXT,
        repo               TEXT,
        issue_number       INTEGER,
        url                TEXT,
        claimed_by_node_id TEXT,
        claimed_at         TIMESTAMPTZ,
        completed_at       TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        dedupe_key         TEXT,
        installation_id    TEXT,
        app_id             TEXT
      );

      -- Idempotency: a redelivered webhook (same delivery id) must not enqueue a
      -- second item. Partial unique index so items without a key are unconstrained.
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
      -- GitHub App installation the node should mint a token for (flavor A).
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS installation_id TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS app_id TEXT;
      -- Collapse the many webhook deliveries one issue emits (opened/labeled/edited)
      -- into a single PENDING item, while still allowing a fresh run after the prior
      -- one finished. default_routed marks shared-queue items re-routable when the
      -- account default node changes; runtime_id/model carry a manual trigger
      -- agent/model override.
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS collapse_key TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS default_routed BOOLEAN;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS runtime_id TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS model TEXT;
      -- Set by the assign endpoint when a device dispatched this item to a
      -- freshly-provisioned ephemeral server rather than an already-running
      -- node (issue #532). Display only; routing is entirely by the label column.
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS ephemeral BOOLEAN;

      CREATE INDEX IF NOT EXISTS idx_nodes_account ON nodes(account_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_token ON nodes(enrollment_token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
      CREATE INDEX IF NOT EXISTS idx_paired_devices_account ON paired_devices(account_id);
      CREATE INDEX IF NOT EXISTS idx_session_index_account ON session_index(account_id);
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account ON push_subscriptions(account_id);
      CREATE INDEX IF NOT EXISTS idx_inbound_hooks_account ON inbound_hooks(account_id);
      CREATE INDEX IF NOT EXISTS idx_work_items_pending ON work_items(account_id, status, label);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_dedupe ON work_items(account_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
      -- One PENDING item per (account, collapse_key). The partial predicate on
      -- status='pending' frees the key once the item is claimed/done, so a later
      -- re-label starts a fresh run rather than colliding forever.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_collapse ON work_items(account_id, collapse_key) WHERE collapse_key IS NOT NULL AND status = 'pending';
    `);
  }

  async close() {
    await this.pool.end();
  }

  // Cheapest possible round-trip to confirm the pool can reach Postgres. Throws
  // (surfacing the connection error) when the database is unreachable.
  async ping() {
    await this.pool.query("SELECT 1");
  }

  // Aggregate row counts for the monitoring dashboard. Six cheap COUNT/GROUP BY
  // queries over already-indexed columns, run in parallel; returns metadata
  // only, never row contents. Called on an interval by the metrics collector,
  // not per request.
  async usageMetrics(): Promise<UsageMetrics> {
    const [accounts, plans, nodes, online, work, sess] = await Promise.all([
      this.query(`SELECT count(*)::int AS n FROM accounts`),
      this.query(`SELECT plan, count(*)::int AS n FROM accounts GROUP BY plan`),
      this.query(`SELECT count(*)::int AS n FROM nodes`),
      this.query(`SELECT count(*)::int AS n FROM nodes WHERE online = true`),
      this.query(`SELECT status, count(*)::int AS n FROM work_items GROUP BY status`),
      this.query(`SELECT status, count(*)::int AS n FROM session_index GROUP BY status`),
    ]);
    const toMap = (rows: Array<Record<string, unknown>>, key: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const row of rows) out[String(row[key] ?? "unknown")] = Number(row.n) || 0;
      return out;
    };
    return {
      accountsTotal: Number(accounts.rows[0]?.n) || 0,
      accountsByPlan: toMap(plans.rows, "plan"),
      nodesTotal: Number(nodes.rows[0]?.n) || 0,
      nodesOnline: Number(online.rows[0]?.n) || 0,
      workItemsByStatus: toMap(work.rows, "status"),
      sessionsByStatus: toMap(sess.rows, "status"),
    };
  }

  // --- Accounts & auth --------------------------------------------------

  async findOrCreateAccount(email: string): Promise<Account> {
    const { rows } = await this.query(
      `INSERT INTO accounts (id, email)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET email = accounts.email
       RETURNING *`,
      [`acct_${randomUUID()}`, email],
    );
    return mapAccount(rows[0]);
  }

  async getAccount(accountId: string): Promise<Account | undefined> {
    const { rows } = await this.query(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    return rows[0] ? mapAccount(rows[0]) : undefined;
  }

  async accountFromStripeCustomer(stripeCustomerId: string): Promise<Account | undefined> {
    const { rows } = await this.query(`SELECT * FROM accounts WHERE stripe_customer_id = $1`, [stripeCustomerId]);
    return rows[0] ? mapAccount(rows[0]) : undefined;
  }

  async setStripeCustomer(accountId: string, stripeCustomerId: string): Promise<void> {
    await this.query(`UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1`, [accountId, stripeCustomerId]);
  }

  async createLoginToken(email: string): Promise<string> {
    await this.findOrCreateAccount(email);
    const token = `mlt_${randomBytes(24).toString("base64url")}`;
    await this.query(
      `INSERT INTO login_tokens (token_hash, email, expires_at) VALUES ($1, $2, $3)`,
      [hashToken(token), email, new Date(Date.now() + LOGIN_TOKEN_TTL_MS)],
    );
    return token;
  }

  async consumeLoginToken(token: string): Promise<Account | undefined> {
    const { rows } = await this.query(
      `DELETE FROM login_tokens WHERE token_hash = $1 RETURNING email, expires_at`,
      [hashToken(token)],
    );
    const rec = rows[0];
    if (!rec) return undefined;
    if (new Date(rec.expires_at).getTime() < Date.now()) return undefined;
    return this.findOrCreateAccount(rec.email);
  }

  async createSession(accountId: string): Promise<string> {
    const token = `sess_${randomBytes(24).toString("base64url")}`;
    await this.query(
      `INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)`,
      [hashToken(token), accountId, new Date(Date.now() + SESSION_TTL_MS)],
    );
    return token;
  }

  async accountFromSession(token: string | null): Promise<Account | undefined> {
    if (!token) return undefined;
    const { rows } = await this.query(
      `SELECT a.* FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    return rows[0] ? mapAccount(rows[0]) : undefined;
  }

  async revokeSession(token: string): Promise<void> {
    await this.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
  }

  async createDeviceLogin(ttlMs = LOGIN_TOKEN_TTL_MS): Promise<{ deviceId: string; deviceSecret: string }> {
    const deviceId = `dev_${randomUUID()}`;
    const deviceSecret = randomBytes(24).toString("base64url");
    await this.query(
      `INSERT INTO device_logins (device_id, secret_hash, expires_at) VALUES ($1, $2, $3)`,
      [deviceId, hashToken(deviceSecret), new Date(Date.now() + ttlMs)],
    );
    return { deviceId, deviceSecret };
  }

  async completeDeviceLogin(deviceId: string, accountId: string): Promise<void> {
    await this.query(
      `UPDATE device_logins SET account_id = $2 WHERE device_id = $1 AND expires_at > now()`,
      [deviceId, accountId],
    );
  }

  async pollDeviceLogin(deviceId: string, deviceSecret: string): Promise<DeviceLoginStatus> {
    const { rows } = await this.query(
      `SELECT secret_hash, account_id, expires_at FROM device_logins WHERE device_id = $1`,
      [deviceId],
    );
    const rec = rows[0];
    if (!rec || rec.secret_hash !== hashToken(deviceSecret)) return { status: "expired" };
    if (new Date(rec.expires_at).getTime() < Date.now()) {
      await this.query(`DELETE FROM device_logins WHERE device_id = $1`, [deviceId]);
      return { status: "expired" };
    }
    if (!rec.account_id) return { status: "pending" };
    // Single delivery: mint the session at poll time so no bearer is stored.
    await this.query(`DELETE FROM device_logins WHERE device_id = $1`, [deviceId]);
    const token = await this.createSession(rec.account_id);
    return { status: "complete", token };
  }

  // --- Client tokens (relay) -------------------------------------------

  async createLinkGrant(accountId: string, nodeId: string, ttlMs = 10 * 60_000): Promise<string> {
    const token = `lnk_${randomBytes(24).toString("base64url")}`;
    await this.query(
      `INSERT INTO link_grants (token_hash, account_id, node_id, expires_at) VALUES ($1, $2, $3, $4)`,
      [hashToken(token), accountId, nodeId, new Date(Date.now() + ttlMs)],
    );
    return token;
  }

  async resolveClient(token: string | null): Promise<ResolvedClient | undefined> {
    if (!token) return undefined;
    const session = await this.accountFromSession(token);
    if (session) return { accountId: session.id, nodeId: null };
    const { rows } = await this.query(
      `SELECT account_id, node_id FROM link_grants WHERE token_hash = $1 AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!rows[0]) return undefined;
    return { accountId: rows[0].account_id, nodeId: rows[0].node_id };
  }

  async registerPairedDevice(accountId: string, publicKeyB64: string, label = "Device"): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(`SELECT account_id FROM paired_devices WHERE public_key_b64 = $1 FOR UPDATE`, [publicKeyB64]);
      const current = existing.rows[0];

      // No device cap — the only guard is that a device key can't be reassigned
      // to a different account.
      if (current && current.account_id !== accountId) {
        throw Object.assign(new Error("Device belongs to another account"), { status: 409 });
      }

      await client.query(
        `INSERT INTO paired_devices (public_key_b64, account_id, label, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (public_key_b64) DO UPDATE SET account_id = $2, label = $3, updated_at = now()`,
        [publicKeyB64, accountId, label.slice(0, 80)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async countPairedDevices(accountId: string): Promise<number> {
    const { rows } = await this.query(`SELECT count(*)::int AS n FROM paired_devices WHERE account_id = $1`, [accountId]);
    return Number(rows[0]?.n ?? 0);
  }

  async listPairedDevices(accountId: string): Promise<PairedDeviceInfo[]> {
    const { rows } = await this.query(
      `SELECT public_key_b64, label, updated_at FROM paired_devices WHERE account_id = $1 ORDER BY updated_at DESC`,
      [accountId],
    );
    return rows.map((row) => ({
      id: row.public_key_b64,
      label: row.label,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async removePairedDevice(accountId: string, publicKeyB64: string): Promise<boolean> {
    const result = await this.query(
      `DELETE FROM paired_devices WHERE account_id = $1 AND public_key_b64 = $2`,
      [accountId, publicKeyB64],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createRelayTicket(input: { role: RelayRole; accountId: string; nodeId: string | null; ttlMs?: number }): Promise<string> {
    const token = `tkt_${randomBytes(24).toString("base64url")}`;
    await this.query(
      `INSERT INTO relay_tickets (token_hash, role, account_id, node_id, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [hashToken(token), input.role, input.accountId, input.nodeId, new Date(Date.now() + (input.ttlMs ?? 2 * 60_000))],
    );
    return token;
  }

  async consumeRelayTicket(token: string | null): Promise<RelayTicket | undefined> {
    if (!token) return undefined;
    // DELETE ... RETURNING makes consumption atomic and single-use.
    const { rows } = await this.query(
      `DELETE FROM relay_tickets WHERE token_hash = $1 RETURNING role, account_id, node_id, expires_at`,
      [hashToken(token)],
    );
    const rec = rows[0];
    if (!rec) return undefined;
    if (new Date(rec.expires_at).getTime() < Date.now()) return undefined;
    return { role: rec.role as RelayRole, accountId: rec.account_id, nodeId: rec.node_id ?? null };
  }

  // --- Billing ----------------------------------------------------------

  async setPlan(accountId: string, plan: Plan, stripeCustomerId?: string): Promise<void> {
    await this.query(
      `UPDATE accounts
       SET plan = $2,
           plan_updated_at = now(),
           stripe_customer_id = COALESCE($3, stripe_customer_id)
       WHERE id = $1`,
      [accountId, plan, stripeCustomerId ?? null],
    );
  }

  async setSubscriptionState(accountId: string, state: SubscriptionState): Promise<void> {
    await this.query(
      `UPDATE accounts
       SET plan = $2,
           plan_updated_at = now(),
           stripe_customer_id = COALESCE($3, stripe_customer_id),
           stripe_subscription_id = $4,
           subscription_status = $5
       WHERE id = $1`,
      [
        accountId,
        state.plan,
        state.stripeCustomerId ?? null,
        state.stripeSubscriptionId ?? null,
        state.subscriptionStatus ?? null,
      ],
    );
  }

  async entitlements(accountId: string): Promise<Entitlements> {
    const account = await this.getAccount(accountId);
    return entitlementsForPlan(account?.plan ?? "free");
  }

  // --- Nodes ------------------------------------------------------------

  async listNodes(accountId: string): Promise<NodeRecord[]> {
    const { rows } = await this.query(
      `SELECT * FROM nodes WHERE account_id = $1 ORDER BY created_at ASC`,
      [accountId],
    );
    return rows.map(mapNode);
  }

  async enrollNode(accountId: string, nodeId: string, name: string) {
    const enrollmentToken = `enr_${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashToken(enrollmentToken);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(`SELECT * FROM nodes WHERE id = $1 FOR UPDATE`, [nodeId]);
      const current = existing.rows[0] ? mapNode(existing.rows[0]) : undefined;
      // Names route work, so keep them unique per account — auto-suffix a collision.
      const takenNames = (
        await client.query(`SELECT name FROM nodes WHERE account_id = $1 AND id <> $2`, [accountId, nodeId])
      ).rows.map((r: { name: string }) => r.name);
      const safeName = disambiguateNodeName(name, takenNames);

      if (!current) {
        const limit = entitlementsForPlan(
          (await client.query(`SELECT plan FROM accounts WHERE id = $1`, [accountId])).rows[0]?.plan ?? "free",
        ).maxNodes;
        const count = Number(
          (await client.query(`SELECT count(*)::int AS n FROM nodes WHERE account_id = $1`, [accountId])).rows[0].n,
        );
        if (limit !== undefined && count >= limit) {
          throw Object.assign(new Error(`Node limit reached (${limit})`), { status: 402 });
        }
      } else if (current.accountId !== accountId) {
        throw Object.assign(new Error("Node belongs to another account"), { status: 409 });
      }

      const { rows } = await client.query(
        `INSERT INTO nodes (id, account_id, name, enrollment_token_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               enrollment_token_hash = EXCLUDED.enrollment_token_hash
         RETURNING *`,
        [nodeId, accountId, safeName, tokenHash],
      );
      await client.query("COMMIT");
      const { enrollmentTokenHash: _h, ...node } = mapNode(rows[0]);
      return { node, enrollmentToken };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async nodeFromEnrollmentToken(token: string | null): Promise<NodeRecord | undefined> {
    if (!token) return undefined;
    const { rows } = await this.query(
      `SELECT * FROM nodes WHERE enrollment_token_hash = $1`,
      [hashToken(token)],
    );
    return rows[0] ? mapNode(rows[0]) : undefined;
  }

  async setNodeOnline(nodeId: string, online: boolean): Promise<void> {
    await this.query(
      `UPDATE nodes SET online = $2, last_seen_at = now() WHERE id = $1`,
      [nodeId, online],
    );
  }

  async setNodeProviders(nodeId: string, providers: NodeProviderSummary[]): Promise<void> {
    await this.query(
      `UPDATE nodes SET providers = $2 WHERE id = $1`,
      [nodeId, JSON.stringify(providers)],
    );
  }

  async setNodeName(nodeId: string, name: string): Promise<NodeRecord | undefined> {
    const clean = cleanNodeName(name);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const node = (await client.query(`SELECT account_id, name FROM nodes WHERE id = $1 FOR UPDATE`, [nodeId])).rows[0];
      if (!node) {
        await client.query("ROLLBACK");
        return undefined;
      }
      // Reject a rename to a name another node on the account already holds.
      const collides = (
        await client.query(`SELECT 1 FROM nodes WHERE account_id = $1 AND id <> $2 AND name = $3 LIMIT 1`, [
          node.account_id,
          nodeId,
          clean,
        ])
      ).rows.length > 0;
      if (collides) throw Object.assign(new Error(`Another node is already named "${clean}"`), { status: 409 });
      const prevName: string = node.name;
      const { rows } = await client.query(
        `UPDATE nodes SET name = $2, last_seen_at = now() WHERE id = $1 RETURNING *`,
        [nodeId, clean],
      );
      // `default_node` is a name (not an id) so the routing label (`bivy/<name>`)
      // stays human-readable — but that means a rename orphans it: the GitHub App
      // "Default node" selector would then show the stale old name (still
      // referenced by default_node) *and* the live node under its new name, as if
      // they were two different nodes. Carry the reference across the rename so
      // it keeps pointing at this node.
      if (prevName !== clean) {
        await client.query(
          `UPDATE inbound_hooks SET default_node = $3 WHERE account_id = $1 AND default_node = $2`,
          [node.account_id, prevName, clean],
        );
      }
      await client.query("COMMIT");
      return rows[0] ? mapNode(rows[0]) : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async removeNode(accountId: string, nodeId: string): Promise<boolean> {
    // Clear any GitHub App hook this node was serving first, so a removed node
    // never leaves a stale "connected" behind (the ghost delete/reinstall left).
    await this.query(
      `UPDATE inbound_hooks SET serving_node_id = NULL, serving_node_seen_at = NULL
       WHERE account_id = $1 AND serving_node_id = $2`,
      [accountId, nodeId],
    );
    const { rowCount } = await this.query(
      `DELETE FROM nodes WHERE id = $1 AND account_id = $2`,
      [nodeId, accountId],
    );
    return (rowCount ?? 0) > 0;
  }

  async replaceNodeSessions(accountId: string, nodeId: string, sessions: SessionAdvert[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Only touch the index if the node belongs to this account.
      const owns = await client.query(`SELECT 1 FROM nodes WHERE id = $1 AND account_id = $2`, [nodeId, accountId]);
      if (owns.rowCount) {
        await client.query(`DELETE FROM session_index WHERE node_id = $1`, [nodeId]);
        for (const s of sessions) {
          await client.query(
            `INSERT INTO session_index (node_id, session_id, account_id, status, source, title_enc, branch, agent_service_address, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
            [nodeId, s.sessionId, accountId, s.status, s.source ?? null, s.titleEnc ?? null, s.branch ?? null, s.agentServiceAddress ?? null],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAccountSessions(accountId: string): Promise<SessionIndexEntry[]> {
    const { rows } = await this.query(
      `SELECT * FROM session_index WHERE account_id = $1 ORDER BY updated_at DESC`,
      [accountId],
    );
    return rows.map((row: any) => ({
      sessionId: row.session_id,
      nodeId: row.node_id,
      status: row.status,
      source: row.source ?? undefined,
      titleEnc: row.title_enc ?? undefined,
      branch: row.branch ?? undefined,
      agentServiceAddress: row.agent_service_address ?? undefined,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async listNodeSessions(accountId: string, nodeId: string): Promise<SessionIndexEntry[]> {
    const { rows } = await this.query(
      `SELECT * FROM session_index WHERE account_id = $1 AND node_id = $2 ORDER BY updated_at DESC`,
      [accountId, nodeId],
    );
    return rows.map((row: any) => ({
      sessionId: row.session_id,
      nodeId: row.node_id,
      status: row.status,
      source: row.source ?? undefined,
      titleEnc: row.title_enc ?? undefined,
      branch: row.branch ?? undefined,
      agentServiceAddress: row.agent_service_address ?? undefined,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async getSessionOwnership(accountId: string, sessionId: string): Promise<SessionOwnership | undefined> {
    const { rows } = await this.query(
      `SELECT * FROM session_ownership WHERE account_id = $1 AND session_id = $2`,
      [accountId, sessionId],
    );
    return rows[0] ? mapOwnership(rows[0]) : undefined;
  }

  async setSessionStandby(
    accountId: string,
    sessionId: string,
    ownerNodeId: string,
    standbyNodeId: string | undefined,
  ): Promise<SessionOwnership> {
    // Upsert without disturbing owner_epoch: a re-declare (new standby, owner
    // reconnect) must not reset the fence. ON CONFLICT keeps the existing epoch.
    const { rows } = await this.query(
      `INSERT INTO session_ownership (account_id, session_id, owner_node_id, standby_node_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (account_id, session_id)
       DO UPDATE SET owner_node_id = EXCLUDED.owner_node_id,
                     standby_node_id = EXCLUDED.standby_node_id,
                     updated_at = now()
       RETURNING *`,
      [accountId, sessionId, ownerNodeId, standbyNodeId ?? null],
    );
    return mapOwnership(rows[0]);
  }

  async promoteSession(
    accountId: string,
    sessionId: string,
    toNodeId: string,
    expectedEpoch: number,
  ): Promise<SessionOwnership | undefined> {
    // Compare-and-set on owner_epoch: only the caller holding the current epoch
    // wins. The row moves to the new owner, the fence advances, and the standby
    // is cleared (the new owner re-declares one). A mismatch returns no rows.
    const { rows } = await this.query(
      `UPDATE session_ownership
          SET owner_node_id = $3, owner_epoch = owner_epoch + 1, standby_node_id = NULL, updated_at = now()
        WHERE account_id = $1 AND session_id = $2 AND owner_epoch = $4
      RETURNING *`,
      [accountId, sessionId, toNodeId, expectedEpoch],
    );
    return rows[0] ? mapOwnership(rows[0]) : undefined;
  }

  async upsertPushSubscription(accountId: string, endpoint: string, subscription: unknown): Promise<void> {
    await this.query(
      `INSERT INTO push_subscriptions (account_id, endpoint, subscription, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (endpoint) DO UPDATE
       SET account_id = EXCLUDED.account_id,
           subscription = EXCLUDED.subscription,
           updated_at = now()`,
      [accountId, endpoint, JSON.stringify(subscription)],
    );
  }

  async removePushSubscription(accountId: string, endpoint: string): Promise<void> {
    await this.query(`DELETE FROM push_subscriptions WHERE account_id = $1 AND endpoint = $2`, [accountId, endpoint]);
  }

  async listPushSubscriptions(accountId: string): Promise<PushSubscriptionRecord[]> {
    const { rows } = await this.query(`SELECT * FROM push_subscriptions WHERE account_id = $1`, [accountId]);
    return rows.map((row: any) => ({
      accountId: row.account_id,
      endpoint: row.endpoint,
      subscription: row.subscription,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async getNotificationPreferences(accountId: string): Promise<NotificationPreferences> {
    const { rows } = await this.query(`SELECT notification_preferences FROM accounts WHERE id = $1`, [accountId]);
    return normalizeNotificationPreferences(rows[0]?.notification_preferences ?? null);
  }

  async setNotificationPreferences(accountId: string, patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
    const current = await this.getNotificationPreferences(accountId);
    const merged = normalizeNotificationPreferences({ ...current, ...patch });
    await this.query(`UPDATE accounts SET notification_preferences = $2 WHERE id = $1`, [accountId, JSON.stringify(merged)]);
    return merged;
  }

  async getEphemeralQueueDefault(accountId: string): Promise<EphemeralQueueDefault> {
    const { rows } = await this.query(`SELECT ephemeral_queue_default FROM accounts WHERE id = $1`, [accountId]);
    return normalizeEphemeralQueueDefault(rows[0]?.ephemeral_queue_default ?? null);
  }

  async setEphemeralQueueDefault(accountId: string, patch: Partial<EphemeralQueueDefault>): Promise<EphemeralQueueDefault> {
    const current = await this.getEphemeralQueueDefault(accountId);
    const merged = normalizeEphemeralQueueDefault({ ...current, ...patch });
    await this.query(`UPDATE accounts SET ephemeral_queue_default = $2 WHERE id = $1`, [accountId, JSON.stringify(merged)]);
    return merged;
  }

  async getModelAuthVault(accountId: string): Promise<ModelAuthVault | undefined> {
    const { rows } = await this.query(`SELECT * FROM model_auth_vaults WHERE account_id = $1`, [accountId]);
    const row = rows[0];
    if (!row) return undefined;
    return { ciphertext: row.ciphertext, updatedAt: new Date(row.updated_at).toISOString(), updatedByNodeId: row.updated_by_node_id };
  }

  async setModelAuthVault(accountId: string, nodeId: string, ciphertext: string): Promise<ModelAuthVault> {
    const { rows } = await this.query(
      `INSERT INTO model_auth_vaults (account_id, ciphertext, updated_by_node_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_by_node_id = EXCLUDED.updated_by_node_id, updated_at = now()
       RETURNING *`,
      [accountId, ciphertext, nodeId],
    );
    return { ciphertext: rows[0].ciphertext, updatedAt: new Date(rows[0].updated_at).toISOString(), updatedByNodeId: rows[0].updated_by_node_id };
  }

  async setModelAuthNodePublicKey(accountId: string, nodeId: string, publicKey: string): Promise<void> {
    await this.query(
      `INSERT INTO model_auth_node_keys (account_id, node_id, public_key, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, node_id) DO UPDATE SET public_key = EXCLUDED.public_key, updated_at = now()`,
      [accountId, nodeId, publicKey],
    );
  }

  async getModelAuthWrappedKey(accountId: string, nodeId: string): Promise<ModelAuthWrappedKey | undefined> {
    const { rows } = await this.query(`SELECT * FROM model_auth_wrapped_keys WHERE account_id = $1 AND node_id = $2`, [accountId, nodeId]);
    const row = rows[0];
    return row ? { nodeId: row.node_id, wrappedKey: row.wrapped_key, wrappedByNodeId: row.wrapped_by_node_id, wrappedByPublicKey: row.wrapped_by_public_key, updatedAt: new Date(row.updated_at).toISOString() } : undefined;
  }

  async requestModelAuthWrappedKey(accountId: string, nodeId: string, publicKey: string): Promise<void> {
    await this.setModelAuthNodePublicKey(accountId, nodeId, publicKey);
    const existing = await this.getModelAuthWrappedKey(accountId, nodeId);
    if (existing) return;
    await this.query(
      `INSERT INTO model_auth_key_requests (account_id, node_id, public_key, created_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, node_id) DO UPDATE SET public_key = EXCLUDED.public_key, created_at = now()`,
      [accountId, nodeId, publicKey],
    );
  }

  async listModelAuthKeyRequests(accountId: string, exceptNodeId: string): Promise<ModelAuthKeyRequest[]> {
    const { rows } = await this.query(
      `SELECT node_id, public_key, created_at FROM model_auth_key_requests WHERE account_id = $1 AND node_id <> $2 ORDER BY created_at ASC`,
      [accountId, exceptNodeId],
    );
    return rows.map((row: any) => ({ nodeId: row.node_id, publicKey: row.public_key, createdAt: new Date(row.created_at).toISOString() }));
  }

  async setModelAuthWrappedKey(accountId: string, targetNodeId: string, wrappedByNodeId: string, wrappedByPublicKey: string, wrappedKey: string): Promise<ModelAuthWrappedKey> {
    const { rows } = await this.query(
      `INSERT INTO model_auth_wrapped_keys (account_id, node_id, wrapped_key, wrapped_by_node_id, wrapped_by_public_key, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (account_id, node_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key, wrapped_by_node_id = EXCLUDED.wrapped_by_node_id, wrapped_by_public_key = EXCLUDED.wrapped_by_public_key, updated_at = now()
       RETURNING *`,
      [accountId, targetNodeId, wrappedKey, wrappedByNodeId, wrappedByPublicKey],
    );
    await this.query(`DELETE FROM model_auth_key_requests WHERE account_id = $1 AND node_id = $2`, [accountId, targetNodeId]);
    return { nodeId: rows[0].node_id, wrappedKey: rows[0].wrapped_key, wrappedByNodeId: rows[0].wrapped_by_node_id, wrappedByPublicKey: rows[0].wrapped_by_public_key, updatedAt: new Date(rows[0].updated_at).toISOString() };
  }

  // --- Inbound hooks + work queue (E2/E4) ------------------------------

  async createInboundHook(accountId: string, kind: string): Promise<InboundHook> {
    const id = `hook_${randomUUID()}`;
    const secret = randomBytes(24).toString("base64url");
    const { rows } = await this.query(
      `INSERT INTO inbound_hooks (id, account_id, kind, secret) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, accountId, kind, secret],
    );
    return mapHook(rows[0]);
  }

  async getInboundHook(id: string): Promise<InboundHook | undefined> {
    const { rows } = await this.query(`SELECT * FROM inbound_hooks WHERE id = $1`, [id]);
    return rows[0] ? mapHook(rows[0]) : undefined;
  }

  async setInboundHookSecret(accountId: string, id: string, secret: string): Promise<InboundHook | undefined> {
    const { rows } = await this.query(
      `UPDATE inbound_hooks SET secret = $3 WHERE id = $2 AND account_id = $1 RETURNING *`,
      [accountId, id, secret],
    );
    return rows[0] ? mapHook(rows[0]) : undefined;
  }

  async setInboundHookAppMeta(
    accountId: string,
    id: string,
    meta: { mention?: string; name?: string; appId?: string; owner?: string; ownerType?: string },
  ): Promise<InboundHook | undefined> {
    // COALESCE keeps the existing value when a field isn't being updated.
    const { rows } = await this.query(
      `UPDATE inbound_hooks
         SET bot_mention    = COALESCE($3, bot_mention),
             app_name       = COALESCE($4, app_name),
             app_id         = COALESCE($5, app_id),
             app_owner      = COALESCE($6, app_owner),
             app_owner_type = COALESCE($7, app_owner_type)
       WHERE id = $2 AND account_id = $1 RETURNING *`,
      [
        accountId,
        id,
        meta.mention?.trim() || null,
        meta.name?.trim() || null,
        meta.appId?.trim() || null,
        meta.owner?.trim() || null,
        meta.ownerType?.trim() || null,
      ],
    );
    return rows[0] ? mapHook(rows[0]) : undefined;
  }

  async setInboundHookServingNode(accountId: string, id: string, nodeId: string): Promise<InboundHook | undefined> {
    const { rows } = await this.query(
      `UPDATE inbound_hooks SET serving_node_id = $3, serving_node_seen_at = now()
       WHERE id = $2 AND account_id = $1 RETURNING *`,
      [accountId, id, nodeId || null],
    );
    return rows[0] ? mapHook(rows[0]) : undefined;
  }

  async setInboundHookInstallStatus(accountId: string, id: string, installCount: number): Promise<InboundHook | undefined> {
    const { rows } = await this.query(
      `UPDATE inbound_hooks SET install_count = $3, installs_synced_at = now()
       WHERE id = $2 AND account_id = $1 RETURNING *`,
      [accountId, id, clampInstallCount(installCount)],
    );
    return rows[0] ? mapHook(rows[0]) : undefined;
  }

  async setInboundHookDefaultNode(accountId: string, id: string, defaultNode: string | undefined): Promise<InboundHook | undefined> {
    const { rows } = await this.query(
      `UPDATE inbound_hooks SET default_node = $3 WHERE id = $2 AND account_id = $1 RETURNING *`,
      [accountId, id, defaultNode?.trim() || null],
    );
    return rows[0] ? mapHook(rows[0]) : undefined;
  }

  async listGithubAppHooks(accountId: string): Promise<InboundHook[]> {
    // Completed hooks (mention registered) first; abandoned create-flow orphans last.
    const { rows } = await this.query(
      `SELECT * FROM inbound_hooks WHERE account_id = $1 AND kind = 'github_app'
       ORDER BY (bot_mention IS NOT NULL) DESC, created_at DESC`,
      [accountId],
    );
    return rows.map(mapHook);
  }

  async getGithubAppHook(accountId: string, appId?: string): Promise<InboundHook | undefined> {
    if (appId) {
      const { rows } = await this.query(
        `SELECT * FROM inbound_hooks WHERE account_id = $1 AND kind = 'github_app' AND app_id = $2
         ORDER BY (bot_mention IS NOT NULL) DESC, created_at DESC LIMIT 1`,
        [accountId, appId],
      );
      return rows[0] ? mapHook(rows[0]) : undefined;
    }
    // Prefer a completed hook (mention registered) over an abandoned-flow orphan.
    const { rows } = await this.query(
      `SELECT * FROM inbound_hooks WHERE account_id = $1 AND kind = 'github_app'
       ORDER BY (bot_mention IS NOT NULL) DESC, created_at DESC LIMIT 1`,
      [accountId],
    );
    return rows[0] ? mapHook(rows[0]) : undefined;
  }

  async deleteGithubAppHooksForApp(accountId: string, appId: string): Promise<number> {
    const { rowCount } = await this.query(
      `DELETE FROM inbound_hooks WHERE account_id = $1 AND kind = 'github_app' AND app_id = $2`,
      [accountId, appId],
    );
    return rowCount ?? 0;
  }

  async deleteInboundHook(accountId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.query(
      `DELETE FROM inbound_hooks WHERE id = $2 AND account_id = $1`,
      [accountId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async deleteGithubAppHooks(accountId: string): Promise<number> {
    const { rowCount } = await this.query(
      `DELETE FROM inbound_hooks WHERE account_id = $1 AND kind = 'github_app'`,
      [accountId],
    );
    return rowCount ?? 0;
  }

  async enqueueWorkItem(accountId: string, input: WorkItemInput): Promise<WorkItem> {
    const dedupeKey = input.dedupeKey ?? null;
    const collapseKey = input.collapseKey ?? null;
    // Two partial-unique constraints can fire: the per-delivery dedupe key and the
    // per-issue collapse key (only against the still-pending row). ON CONFLICT DO
    // NOTHING covers both; on either conflict we return the existing item.
    const { rows } = await this.query(
      `INSERT INTO work_items (id, account_id, label, source, status, title, body, repo, issue_number, url, dedupe_key, collapse_key, default_routed, runtime_id, model, installation_id, app_id)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        `work_${randomUUID()}`,
        accountId,
        normalizeWorkLabel(input.label),
        input.source,
        input.title,
        input.body ?? null,
        input.repo ?? null,
        input.issueNumber ?? null,
        input.url ?? null,
        dedupeKey,
        collapseKey,
        input.defaultRouted ?? null,
        input.runtimeId ?? null,
        input.model ?? null,
        input.installationId ?? null,
        input.appId ?? null,
      ],
    );
    if (rows[0]) return mapWorkItem(rows[0]);
    // Conflict: a redelivery (dedupe key) or another delivery for an issue that
    // already has a pending item (collapse key). Return the existing one so the
    // caller stays idempotent and no duplicate lands in the queue.
    if (dedupeKey) {
      const existing = await this.query(
        `SELECT * FROM work_items WHERE account_id = $1 AND dedupe_key = $2 LIMIT 1`,
        [accountId, dedupeKey],
      );
      if (existing.rows[0]) return mapWorkItem(existing.rows[0]);
    }
    const existingPending = await this.query(
      `SELECT * FROM work_items WHERE account_id = $1 AND collapse_key = $2 AND status = 'pending' LIMIT 1`,
      [accountId, collapseKey],
    );
    return mapWorkItem(existingPending.rows[0]);
  }

  async rerouteDefaultRoutedPending(accountId: string, label: string): Promise<WorkItem[]> {
    const next = normalizeWorkLabel(label);
    const { rows } = await this.query(
      `UPDATE work_items SET label = $2
       WHERE account_id = $1 AND status = 'pending' AND default_routed = true AND label <> $2
       RETURNING *`,
      [accountId, next],
    );
    return rows.map(mapWorkItem);
  }

  async assignWorkItem(
    accountId: string,
    id: string,
    input: { label: string; runtimeId?: string; model?: string; ephemeral?: boolean },
  ): Promise<WorkItem | undefined> {
    const { rows } = await this.query(
      `UPDATE work_items
       SET label = $3, runtime_id = $4, model = $5, default_routed = false, ephemeral = $6
       WHERE id = $2 AND account_id = $1 AND status = 'pending'
       RETURNING *`,
      [accountId, id, normalizeWorkLabel(input.label), input.runtimeId?.trim() || null, input.model?.trim() || null, Boolean(input.ephemeral)],
    );
    return rows[0] ? mapWorkItem(rows[0]) : undefined;
  }

  async listPendingWorkItems(accountId: string, labels: string[]): Promise<WorkItem[]> {
    if (labels.length === 0) return [];
    const { rows } = await this.query(
      `SELECT * FROM work_items
       WHERE account_id = $1 AND status = 'pending' AND label = ANY($2)
       ORDER BY created_at ASC`,
      [accountId, labels],
    );
    return rows.map(mapWorkItem);
  }

  async listWorkItems(accountId: string, limit = 50): Promise<WorkItem[]> {
    const { rows } = await this.query(
      `SELECT * FROM work_items WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [accountId, Math.max(1, Math.min(200, limit))],
    );
    return rows.map(mapWorkItem);
  }

  async claimWorkItem(accountId: string, nodeId: string, id: string): Promise<WorkItem | undefined> {
    // Conditional UPDATE makes the claim atomic: only the row still pending flips.
    const { rows } = await this.query(
      `UPDATE work_items
       SET status = 'claimed', claimed_by_node_id = $3, claimed_at = now()
       WHERE id = $2 AND account_id = $1 AND status = 'pending'
       RETURNING *`,
      [accountId, id, nodeId],
    );
    return rows[0] ? mapWorkItem(rows[0]) : undefined;
  }

  async countWorkRunsSince(accountId: string, sinceIso: string): Promise<number> {
    // One claimed item = one run. `claimed_at` is stamped once (the claim UPDATE
    // only flips a still-pending row), so a claimed OR done item counts exactly
    // once; still-pending items (never claimed) don't count.
    const { rows } = await this.query(
      `SELECT count(*)::int AS n FROM work_items
       WHERE account_id = $1 AND claimed_at IS NOT NULL AND claimed_at >= $2`,
      [accountId, sinceIso],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async completeWorkItem(accountId: string, id: string): Promise<void> {
    await this.query(
      `UPDATE work_items SET status = 'done', completed_at = now() WHERE id = $2 AND account_id = $1`,
      [accountId, id],
    );
  }

  async deleteWorkItem(accountId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.query(
      `DELETE FROM work_items WHERE id = $2 AND account_id = $1`,
      [accountId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async clearPendingWorkItems(accountId: string): Promise<number> {
    const { rowCount } = await this.query(
      `DELETE FROM work_items WHERE account_id = $1 AND status = 'pending'`,
      [accountId],
    );
    return rowCount ?? 0;
  }
}

function mapHook(row: any): InboundHook {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    secret: row.secret,
    createdAt: new Date(row.created_at).toISOString(),
    botMention: row.bot_mention ?? undefined,
    appName: row.app_name ?? undefined,
    appId: row.app_id ?? undefined,
    appOwner: row.app_owner ?? undefined,
    appOwnerType: row.app_owner_type ?? undefined,
    installCount: row.install_count ?? undefined,
    installsSyncedAt: row.installs_synced_at ? new Date(row.installs_synced_at).toISOString() : undefined,
    defaultNode: row.default_node ?? undefined,
    servingNodeId: row.serving_node_id ?? undefined,
    servingNodeSeenAt: row.serving_node_seen_at ? new Date(row.serving_node_seen_at).toISOString() : undefined,
  };
}

function mapWorkItem(row: any): WorkItem {
  return {
    id: row.id,
    accountId: row.account_id,
    label: row.label,
    source: row.source,
    status: row.status,
    title: row.title,
    body: row.body ?? undefined,
    repo: row.repo ?? undefined,
    issueNumber: row.issue_number ?? undefined,
    url: row.url ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    claimedByNodeId: row.claimed_by_node_id ?? undefined,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    collapseKey: row.collapse_key ?? undefined,
    defaultRouted: row.default_routed ?? undefined,
    runtimeId: row.runtime_id ?? undefined,
    model: row.model ?? undefined,
    installationId: row.installation_id ?? undefined,
    appId: row.app_id ?? undefined,
    ephemeral: row.ephemeral ?? undefined,
  };
}

function mapAccount(row: any): Account {
  return {
    id: row.id,
    email: row.email,
    plan: row.plan as Plan,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
    subscriptionStatus: row.subscription_status ?? null,
    planUpdatedAt: row.plan_updated_at ? new Date(row.plan_updated_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapNode(row: any): NodeRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    enrollmentTokenHash: row.enrollment_token_hash,
    online: row.online,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    providers: row.providers ?? undefined,
  };
}

function mapOwnership(row: any): SessionOwnership {
  return {
    sessionId: row.session_id,
    accountId: row.account_id,
    ownerNodeId: row.owner_node_id,
    standbyNodeId: row.standby_node_id ?? undefined,
    ownerEpoch: Number(row.owner_epoch),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
