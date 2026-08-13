// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import { encryptSecret, decryptSecret, isSecretEnvelope, type SecretEnvelope } from "./hosted-crypto.js";
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
  type EphemeralNodeConfig,
  normalizeEphemeralConfigs,
  type QueueRouting,
  normalizeQueueRouting,
  type HostedProvisioning,
  providerCredentialFingerprint,
  normalizeHostedProvisioning,
  DEFAULT_HOSTED_PROVISIONING,
  type HostedProvisioningStatus,
  type HostedAuditEvent,
  type ModelAuthVault,
  type ModelAuthWrappedKey,
  type ModelAuthKeyRequest,
  type DeviceVault,
  type DeviceVaultWrappedKeyRecord,
  type DeviceVaultKeyRequest,
  type SessionSnapshotRecord,
  type SessionCorrelation,
  type SessionCorrelationInput,
  type GithubAppVault,
  type GithubAppWrappedKey,
  type GithubAppKeyRequest,
  type SubscriptionState,
  type InboundHook,
  type UsageMetrics,
  type WorkItem,
  type WorkItemInput,
  type AutomationDefinition,
  type AutomationRun,
  type AutomationRunStatus,
  type CancelAutomationRunResult,
  type RetryAutomationRunResult,
  type AutomationTriggerKind,
  type TriggerEvent,
  type RunEvidenceEvent,
  type RunCheck,
  type RunEvidencePatch,
  entitlementsForPlan,
  hashToken,
  disambiguateNodeName,
  cleanNodeName,
  normalizeWorkLabel,
  clampInstallCount,
  LOGIN_TOKEN_TTL_MS,
  SESSION_TTL_MS,
} from "./store.js";

// A claimed Run's renewable lease. A live node renews every ~30s; if it crashes
// the item becomes reclaimable once this expires. Overridable via env for tuning
// and for deterministic reclaim tests (default two minutes).
const WORK_LEASE_MS = ((): number => {
  const raw = Number(process.env.BIVY_WORK_LEASE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 1000;
})();
const workLeaseExpiry = (): string => new Date(Date.now() + WORK_LEASE_MS).toISOString();

/**
 * The control plane's single store implementation, backed by Postgres — a durable
 * database when `DATABASE_URL` is set, or an in-memory Postgres (pg-mem) for
 * dev/tests otherwise (see pg-mem-store.ts). Both go through `createStore()`
 * (store-factory.ts), so there is no second hand-mirrored implementation.
 *
 * Same hard rule as the rest of the control plane: never store interactive
 * session content, files, transcripts, or tool output. Slack and generic-webhook
 * instructions are the explicit inbound-automation exception retained in
 * work-item title/body. Model provider credentials are stored only as encrypted
 * account-vault ciphertext for cross-node auth. All bearer tokens are stored hashed
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
      -- Account-level ephemeral node configs (reusable runner templates) and the
      -- account's default queue routing (primary runner + optional fallback).
      -- Non-secret; provider tokens stay device-local. See store.ts.
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ephemeral_configs JSONB;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS queue_routing     JSONB;
      -- Hosted provisioning: control-plane-held credentials + enable flag, and a
      -- tracking list of machines the control plane launched itself. Off by
      -- default; SECURITY: encrypt these at rest in production (see store.ts).
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS hosted_provisioning JSONB;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS hosted_machines     JSONB;
      -- Append-only audit trail of hosted-credential use (capped in app code).
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS hosted_audit         JSONB;
      CREATE TABLE IF NOT EXISTS hosted_provision_leases (
        account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        holder      TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL
      );
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

      -- Shared across control-plane replicas: an OAuth callback need not return
      -- to the process that initiated it, and auth throttles cannot be bypassed
      -- by letting the load balancer pick another process.
      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash   TEXT PRIMARY KEY,
        device_id    TEXT,
        return_path  TEXT,
        expires_at   TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        bucket_key_hash TEXT PRIMARY KEY,
        request_count   INTEGER NOT NULL,
        reset_at        TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
      CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_reset ON auth_rate_limits(reset_at);

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
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS bootstrap_status JSONB;

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
      ALTER TABLE session_index ADD COLUMN IF NOT EXISTS attention JSONB;

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
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        needs_rotation      BOOLEAN NOT NULL DEFAULT false
      );
      ALTER TABLE model_auth_vaults ADD COLUMN IF NOT EXISTS needs_rotation BOOLEAN NOT NULL DEFAULT false;

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

      -- Hosted escrow of the model-auth vault KEY (node-less inheritance). Sealed at
      -- rest with the per-account hosted key so a LONE hosted ephemeral can decrypt
      -- the synced vault without a peer to wrap the key. One row per account, written
      -- and served ONLY for hosted-provisioning accounts (gated at the endpoint).
      CREATE TABLE IF NOT EXISTS hosted_model_auth_keys (
        account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        key_enc     JSONB NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS model_auth_key_requests (
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        public_key  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, node_id)
      );

      -- GitHub App private-key vault (issue #88) — same E2E shape as the model-auth
      -- vault above, but keyed per (account, app): an account can hold several apps
      -- (personal + one per org), and they sync independently. See GithubAppVault
      -- in store.ts for the field-level rationale.
      CREATE TABLE IF NOT EXISTS github_app_vaults (
        account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        app_id              TEXT NOT NULL,
        ciphertext          TEXT NOT NULL,
        updated_by_node_id  TEXT NOT NULL,
        needs_rotation      BOOLEAN NOT NULL DEFAULT false,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, app_id)
      );

      CREATE TABLE IF NOT EXISTS github_app_wrapped_keys (
        account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        app_id                 TEXT NOT NULL,
        node_id                TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        wrapped_key            TEXT NOT NULL,
        wrapped_by_node_id     TEXT NOT NULL,
        wrapped_by_public_key  TEXT NOT NULL DEFAULT '',
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, app_id, node_id)
      );

      CREATE TABLE IF NOT EXISTS github_app_key_requests (
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        app_id      TEXT NOT NULL,
        node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        public_key  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, app_id, node_id)
      );

      -- Device→device ephemeral-provider-token vault (P2 / Gap A). Same E2E shape
      -- as the model-auth vault above — the control plane holds ciphertext plus
      -- per-recipient wrapped keys, never a plaintext token — but the recipients
      -- are the account's paired DEVICES (identified by their X25519 public key,
      -- the PK of paired_devices), not nodes. So a second device can wake/reach an
      -- ephemeral machine the first launched. See createDeviceVaultKeyStore in
      -- packages/core/src/device-vault.ts.
      CREATE TABLE IF NOT EXISTS device_vaults (
        account_id         TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        ciphertext         TEXT NOT NULL,
        updated_by_device  TEXT NOT NULL,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS device_vault_wrapped_keys (
        account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        device_pub             TEXT NOT NULL,
        wrapped_key            TEXT NOT NULL,
        wrapped_by_public_key  TEXT NOT NULL,
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, device_pub)
      );

      CREATE TABLE IF NOT EXISTS device_vault_key_requests (
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        device_pub  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, device_pub)
      );

      -- Durable, node-independent, E2E-encrypted session snapshots (Gap B). Keyed
      -- by SESSION (not node) so it outlives the machine's teardown, mirroring
      -- session_ownership. Opaque ciphertext only (a sealed replication frame),
      -- like session_index.title_enc — the control plane can't read it. Lets a
      -- torn-down destroy-lane session be rebuilt onto a fresh machine.
      CREATE TABLE IF NOT EXISTS session_snapshots (
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL,
        ciphertext  TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, session_id)
      );

      -- Durable session↔machine correlation (Gap 1). Lets a torn-down destroy-lane
      -- session be rebuilt AFTER its node is unenrolled and drops from the registry:
      -- records the reusable eph-* node id + non-secret launch params. Keyed by
      -- session and deliberately NOT FK-cascaded off nodes, so it outlives teardown
      -- (like session_snapshots). Never holds a credential.
      CREATE TABLE IF NOT EXISTS session_correlation (
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        provider    TEXT NOT NULL,
        region      TEXT,
        ttl_minutes INTEGER,
        repo        TEXT,
        setup_id    TEXT,
        machine_id  TEXT,
        app         TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, session_id)
      );

      -- Escrowed session ROOM KEY for HOSTED (device-offline) rebuild (Gap 3).
      -- Sealed at rest with the per-account hosted-provisioning key (hosted-crypto),
      -- keyed by the reusable eph-* node id and deliberately NOT FK-cascaded off
      -- nodes so it survives teardown/unenroll. Only written for hosted-provisioning
      -- accounts (whose provider/GitHub creds the control plane already holds); a
      -- device-launched session keeps its room key device-only and never escrows.
      CREATE TABLE IF NOT EXISTS node_room_keys (
        account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        node_id      TEXT NOT NULL,
        room_key_enc JSONB NOT NULL,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
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
      -- Who may @-mention-trigger a run via a GitHub issue/comment: NULL/
      -- 'everyone' (no restriction, the prior behavior), 'contributor' (any
      -- prior relationship with the repo), or 'collaborator' (push access
      -- only). See meetsTriggerAccess in webhooks.ts (issue #259).
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS trigger_access TEXT;
      -- The node currently holding this GitHub App's key and servicing it. Cleared
      -- when that node is removed, so the UI shows "no node serving" instead of a
      -- stale "connected" after a node delete/reinstall.
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS serving_node_id      TEXT;
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS serving_node_seen_at TIMESTAMPTZ;
      -- Generic automation hooks use a deliberately non-executable template:
      -- a fixed instruction prefix plus the event instruction as plain text.
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS template_instruction TEXT;
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS routing_default TEXT;
      ALTER TABLE inbound_hooks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

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
        external_id        TEXT,
        url                TEXT,
        claimed_by_node_id TEXT,
        claimed_at         TIMESTAMPTZ,
        lease_expires_at   TIMESTAMPTZ,
        completed_at       TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        dedupe_key         TEXT,
        installation_id    TEXT,
        app_id             TEXT
      );

      -- Idempotency: a redelivered webhook (same delivery id) must not enqueue a
      -- second item. Partial unique index so items without a key are unconstrained.
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
      -- Provider-native identifier used for just-in-time issue retrieval (Linear).
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS external_id TEXT;
      -- GitHub App installation the node should mint a token for (flavor A).
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS installation_id TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS app_id TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
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
      -- Automation is the canonical domain. Existing work_items are migrated in
      -- place so old API clients retain their ids and issue context.
      CREATE TABLE IF NOT EXISTS automation_definitions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        template_ciphertext TEXT,
        runtime_id TEXT,
        model TEXT,
        node_label TEXT,
        ephemeral BOOLEAN,
        approval_mode TEXT,
        sandbox TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        schedule JSONB NOT NULL DEFAULT '{"kind":"once","at":"9999-12-31T00:00:00.000Z"}',
        next_run_at TIMESTAMPTZ,
        last_scheduled_at TIMESTAMPTZ,
        trigger TEXT,
        webhook_secret TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- CREATE TABLE IF NOT EXISTS is a no-op on a pre-existing table, so a DB
      -- created before these columns existed never gets them — and init() then
      -- crashes the whole control plane on the idx_automation_definitions_due
      -- index below (which references next_run_at/enabled). Backfill them the
      -- same way work_items does, before any statement that reads them.
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS approval_mode TEXT;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS sandbox TEXT;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS schedule JSONB NOT NULL DEFAULT '{"kind":"once","at":"9999-12-31T00:00:00.000Z"}';
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS last_scheduled_at TIMESTAMPTZ;
      -- Webhook-triggerable automations (a definition fired by a signed POST
      -- rather than only its schedule): trigger distinguishes the source and
      -- webhook_secret is the HMAC key for the /webhooks/automation/run path.
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS trigger TEXT;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
      -- Workspace target for triggers that do not carry a repo (schedule, etc.).
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS repo TEXT;
      -- Source-trigger filters (github/linear) + built-in template id.
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS labels JSONB;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS repos JSONB;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS template_id TEXT;
      -- GitHub event rules ("when"). JSON array of { event, actions?, labels?, mention?, … }.
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS on_events JSONB;
      -- Scheduled runs that CONTINUE an existing session (scheduled chat
      -- messages) instead of starting a new one. Mirrors work_items.target_*.
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS target_kind TEXT;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS target_session_id TEXT;
      -- Scheduled/manual runs that are plain chat messages rather than automation
      -- jobs (the node skips the boilerplate/push/checks).
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS message BOOLEAN NOT NULL DEFAULT false;
      -- Source-controlled identity + hard attempt ceiling for automation-as-code.
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS config_key TEXT;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS config_order INTEGER;
      ALTER TABLE automation_definitions ADD COLUMN IF NOT EXISTS max_attempts INTEGER;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_definitions_config_key
        ON automation_definitions(account_id, config_key) WHERE config_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS trigger_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        source_key TEXT,
        source_ref JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_events_source
        ON trigger_events(account_id, source_key) WHERE source_key IS NOT NULL;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS definition_id TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS trigger_id TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS trigger_kind TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'new_session';
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS target_session_id TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS message BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS output JSONB;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS approval_mode TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS sandbox TEXT;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS max_attempts INTEGER;
      -- Untrusted webhook-payload context for a webhook-triggered automation run,
      -- appended to the E2E-decrypted operator template on the node as data.
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS event_context TEXT;
      -- Privacy-safe run evidence (issue #153): why this node/runtime was chosen,
      -- declared-check results, and an ordered event timeline. All three are
      -- allowlisted/bounded by run-evidence.ts before they ever reach here.
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS routing_reason TEXT;
      -- Explicit ::jsonb cast on the default (not just relying on the column
      -- type): without it, pg-mem — the in-memory Postgres the test suite runs
      -- against — stores the literal two-character text "[]" instead of an
      -- empty JSON array, which then silently corrupts every array spread.
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS checks JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS events JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE work_items ADD COLUMN IF NOT EXISTS receipt_evidence JSONB;
      INSERT INTO trigger_events (id, account_id, kind, created_at)
        SELECT 'legacy:' || id, account_id,
          CASE WHEN source LIKE 'github:%' THEN 'github'
               WHEN source = 'slack' THEN 'slack'
               WHEN source = 'manual' THEN 'manual'
               ELSE 'webhook' END,
          created_at
        FROM work_items
        WHERE trigger_id IS NULL
        ON CONFLICT DO NOTHING;
      -- Backfill only the rows that still need it. Without this predicate the
      -- statement rewrites every work_items row on every control-plane start.
      UPDATE work_items SET
        trigger_id = COALESCE(trigger_id, 'legacy:' || id),
        trigger_kind = COALESCE(trigger_kind,
          CASE WHEN source LIKE 'github:%' THEN 'github'
               WHEN source = 'slack' THEN 'slack'
               WHEN source = 'manual' THEN 'manual'
               ELSE 'webhook' END),
        status = CASE WHEN status = 'done' THEN 'succeeded' ELSE status END
      WHERE trigger_id IS NULL OR trigger_kind IS NULL OR status = 'done';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_occurrence
        ON work_items(account_id, dedupe_key) WHERE dedupe_key LIKE 'schedule:%';
      CREATE INDEX IF NOT EXISTS idx_automation_definitions_due
        ON automation_definitions(next_run_at) WHERE enabled = true;

      -- One row per distinct run the account has started, keyed by run key (the
      -- session id). Powers the free-tier daily cap: runs today = rows whose
      -- started_at >= start-of-UTC-day. PRIMARY KEY(account_id, run_key) makes
      -- recordRunStart idempotent so reconnects / repeated session advertises never
      -- double-count. Metadata only — no session content ever lands here.
      CREATE TABLE IF NOT EXISTS run_starts (
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        run_key     TEXT NOT NULL,
        started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, run_key)
      );

      -- Lifetime hosted-session trial meter. One row per DISTINCT session ever
      -- surfaced through the hosted index, deduped by PRIMARY KEY so re-advertises
      -- never inflate it. Unlike run_starts this is NEVER pruned — it is durable
      -- billing state, not a rolling window — so the "first N sessions are free"
      -- trial can't be reset by ageing rows out. Which sessions fall outside the
      -- allowance is decided at READ time (by first_seen order vs the plan limit),
      -- so a session allowed once stays allowed and upgrading needs no backfill.
      -- Metadata only: an account id, an opaque session id, a timestamp.
      CREATE TABLE IF NOT EXISTS trial_sessions (
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL,
        first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, session_id)
      );

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
      CREATE INDEX IF NOT EXISTS idx_run_starts_account_time ON run_starts(account_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_trial_sessions_account_seen ON trial_sessions(account_id, first_seen);
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

  async createOAuthState(input: { deviceId?: string; returnPath?: string }, ttlMs = 10 * 60_000): Promise<string> {
    const state = randomBytes(24).toString("base64url");
    await this.query(
      `INSERT INTO oauth_states (state_hash, device_id, return_path, expires_at) VALUES ($1, $2, $3, $4)`,
      [hashToken(state), input.deviceId ?? null, input.returnPath ?? null, new Date(Date.now() + ttlMs)],
    );
    return state;
  }

  async consumeOAuthState(state: string): Promise<{ deviceId?: string; returnPath?: string } | undefined> {
    if (!state) return undefined;
    // DELETE ... RETURNING makes the CSRF state single-use even when two
    // callbacks race on different replicas.
    const { rows } = await this.query(
      `DELETE FROM oauth_states WHERE state_hash = $1 RETURNING device_id, return_path, expires_at`,
      [hashToken(state)],
    );
    const rec = rows[0];
    if (!rec || new Date(rec.expires_at).getTime() < Date.now()) return undefined;
    return {
      ...(rec.device_id ? { deviceId: rec.device_id } : {}),
      ...(rec.return_path ? { returnPath: rec.return_path } : {}),
    };
  }

  async rateLimitExceeded(bucket: string, key: string, limit: number, windowMs: number): Promise<boolean> {
    const bucketKeyHash = hashToken(`${bucket}\u0000${key}`);
    const resetAt = new Date(Date.now() + Math.max(1, windowMs));
    // One atomic UPSERT is the fleet-wide fixed-window counter. PostgreSQL locks
    // the conflicting row, so concurrent requests on different replicas cannot
    // lose increments.
    const { rows } = await this.query(
      `INSERT INTO auth_rate_limits (bucket_key_hash, request_count, reset_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (bucket_key_hash) DO UPDATE SET
         request_count = CASE WHEN auth_rate_limits.reset_at <= now() THEN 1 ELSE auth_rate_limits.request_count + 1 END,
         reset_at = CASE WHEN auth_rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE auth_rate_limits.reset_at END
       RETURNING request_count`,
      [bucketKeyHash, resetAt],
    );
    return Number(rows[0]?.request_count ?? 1) > Math.max(0, limit);
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
      return { node, enrollmentToken, created: !current };
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
    // Only bump `last_seen_at` when marking ONLINE. This makes the column mean
    // "last time we confirmed the node online", which the read path (`GET /nodes`)
    // uses as a TTL fallback: a stale/racing `online=false` write (fire-and-forget
    // from a relay socket close, possibly out of order with a fresh reconnect's
    // `true`, or from a stale replica) must NOT refresh `last_seen_at`, or it would
    // keep a genuinely-offline node looking recently-seen. Paired with the daemon's
    // periodic `/node/heartbeat`, a connected node's `last_seen_at` stays fresh so a
    // lost connect/close race self-heals instead of pinning the node offline.
    if (online) {
      await this.query(
        `UPDATE nodes SET online = true, last_seen_at = now() WHERE id = $1`,
        [nodeId],
      );
    } else {
      await this.query(
        `UPDATE nodes SET online = false WHERE id = $1`,
        [nodeId],
      );
    }
  }

  async setNodeProviders(nodeId: string, providers: NodeProviderSummary[]): Promise<void> {
    await this.query(
      `UPDATE nodes SET providers = $2 WHERE id = $1`,
      [nodeId, JSON.stringify(providers)],
    );
  }

  async setNodeBootstrapStatus(nodeId: string, phase: string): Promise<void> {
    await this.query(
      `UPDATE nodes SET bootstrap_status = $2 WHERE id = $1`,
      [nodeId, JSON.stringify({ phase, updatedAt: new Date().toISOString() })],
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Clear any GitHub App hook this node was serving first, so a removed node
      // never leaves a stale "connected" behind (the ghost delete/reinstall left).
      await client.query(
      `UPDATE inbound_hooks SET serving_node_id = NULL, serving_node_seen_at = NULL
       WHERE account_id = $1 AND serving_node_id = $2`,
        [accountId, nodeId],
      );
      // A removed node keeps whatever it already cached locally — deleting its
      // wrapped_keys row only stops future resolution. Flag each vault it held,
      // then delete the node in the SAME transaction so a survivor can never
      // rotate/re-wrap while the revoked node is still eligible for a fresh key.
      await client.query(
      `UPDATE github_app_vaults SET needs_rotation = true
       WHERE account_id = $1 AND app_id IN (
         SELECT app_id FROM github_app_wrapped_keys WHERE account_id = $1 AND node_id = $2
       )`,
        [accountId, nodeId],
      );
      await client.query(
      `UPDATE model_auth_vaults SET needs_rotation = true
       WHERE account_id = $1 AND EXISTS (
         SELECT 1 FROM model_auth_wrapped_keys WHERE account_id = $1 AND node_id = $2
       )`,
        [accountId, nodeId],
      );
      const { rowCount } = await client.query(
        `DELETE FROM nodes WHERE id = $1 AND account_id = $2`,
        [nodeId, accountId],
      );
      await client.query("COMMIT");
      return (rowCount ?? 0) > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceNodeSessions(accountId: string, nodeId: string, sessions: SessionAdvert[]): Promise<number> {
    const client = await this.pool.connect();
    let newRunStarts = 0;
    try {
      await client.query("BEGIN");
      // Only touch the index if the node belongs to this account.
      const owns = await client.query(`SELECT 1 FROM nodes WHERE id = $1 AND account_id = $2`, [nodeId, accountId]);
      if (owns.rowCount) {
        await client.query(`DELETE FROM session_index WHERE node_id = $1`, [nodeId]);
        // Batched via a multi-row VALUES insert instead of one round trip per
        // session: every node advertise (1s-debounced, plus a 60s full resync
        // per node — see src/server.ts) used to cost 2 sequential awaited
        // queries PER session (insert into session_index, insert into
        // run_starts) on one held pooled connection. That's fine at 1-2
        // sessions but scales linearly with concurrent nodes × sessions ×
        // advertise frequency; batching drops it to a fixed 2 queries no
        // matter how many sessions are in the advert. (Plain multi-row VALUES,
        // not unnest($1::text[], ...) — pg-mem, which the whole store is
        // deliberately tested against, doesn't support multi-array unnest.)
        if (sessions.length > 0) {
          const sessionIndexCols = 10;
          const sessionIndexValues: unknown[] = [];
          const sessionIndexRows = sessions
            .map((s, i) => {
              const base = i * sessionIndexCols;
              sessionIndexValues.push(
                nodeId,
                s.sessionId,
                accountId,
                s.status,
                s.source ?? null,
                s.titleEnc ?? null,
                s.branch ?? null,
                s.agentServiceAddress ?? null,
                JSON.stringify(s.attention ?? []),
                s.updatedAt ?? new Date(),
              );
              return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
            })
            .join(", ");
          await client.query(
            `INSERT INTO session_index (node_id, session_id, account_id, status, source, title_enc, branch, agent_service_address, attention, updated_at)
             VALUES ${sessionIndexRows}`,
            sessionIndexValues,
          );
          // Count each run the first time its session is advertised. The session
          // index is rewritten wholesale on every advertise, but run_starts is
          // keyed by (account, session) with DO NOTHING, so a session only ever
          // counts once — the day it first appears. This is the single funnel
          // through which EVERY source (manual, app, work queue, ephemeral) lands
          // in the daily counter, since every run eventually advertises a session.
          const runStartsRows = sessions.map((_, i) => `($1, $${i + 2})`).join(", ");
          // Read existing keys first only to work around pg-mem returning rows
          // for ON CONFLICT DO NOTHING. Real Postgres's RETURNING remains the
          // concurrency authority; filtering known rows makes both agree.
          const existingRuns = await client.query(
            `SELECT run_key FROM run_starts WHERE account_id = $1 AND run_key IN (${sessions.map((_, i) => `$${i + 2}`).join(", ")})`,
            [accountId, ...sessions.map((s) => s.sessionId)],
          );
          const existingKeys = new Set(existingRuns.rows.map((row: { run_key: string }) => row.run_key));
          const insertedRuns = await client.query(
            `INSERT INTO run_starts (account_id, run_key)
             VALUES ${runStartsRows}
             ON CONFLICT (account_id, run_key) DO NOTHING
             RETURNING run_key`,
            [accountId, ...sessions.map((s) => s.sessionId)],
          );
          newRunStarts = insertedRuns.rows.filter((row: { run_key: string }) => !existingKeys.has(row.run_key)).length;
          // Mirror into the durable, never-pruned trial ledger in the same batch.
          // Deduped by PRIMARY KEY, so a session's first_seen is pinned the day it
          // first appears and re-advertises are no-ops — the lifetime trial count is
          // stable regardless of how often a session is re-advertised. Limit-agnostic
          // by design: whether a session is inside the allowance is decided at read
          // time (overTrialSessionIds), so this path needs no plan/enforcement lookup.
          const trialRows = sessions.map((_, i) => `($1, $${i + 2})`).join(", ");
          await client.query(
            `INSERT INTO trial_sessions (account_id, session_id)
             VALUES ${trialRows}
             ON CONFLICT (account_id, session_id) DO NOTHING`,
            [accountId, ...sessions.map((s) => s.sessionId)],
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
    return newRunStarts;
  }

  async upsertNodeSession(accountId: string, nodeId: string, session: SessionAdvert): Promise<boolean> {
    const client = await this.pool.connect();
    let runStarted = false;
    try {
      await client.query("BEGIN");
      // Only touch the index if the node belongs to this account (mirrors
      // replaceNodeSessions' ownership fence).
      const owns = await client.query(`SELECT 1 FROM nodes WHERE id = $1 AND account_id = $2`, [nodeId, accountId]);
      if (owns.rowCount) {
        // Single-row upsert keyed by the (node_id, session_id) primary key: one
        // fixed-cost write per status flip, independent of how many sessions the
        // node has — unlike the wholesale DELETE+reinsert in replaceNodeSessions.
        await client.query(
          `INSERT INTO session_index (node_id, session_id, account_id, status, source, title_enc, branch, agent_service_address, attention, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (node_id, session_id) DO UPDATE
             SET status = EXCLUDED.status,
                 source = EXCLUDED.source,
                 title_enc = EXCLUDED.title_enc,
                 branch = EXCLUDED.branch,
                 agent_service_address = EXCLUDED.agent_service_address,
                 attention = EXCLUDED.attention,
                 updated_at = EXCLUDED.updated_at`,
          [
            nodeId,
            session.sessionId,
            accountId,
            session.status,
            session.source ?? null,
            session.titleEnc ?? null,
            session.branch ?? null,
            session.agentServiceAddress ?? null,
            JSON.stringify(session.attention ?? []),
            session.updatedAt ?? new Date(),
          ],
        );
        // Count each run the first time its session is advertised — same funnel
        // as replaceNodeSessions (keyed by (account, session), DO NOTHING, so a
        // session only ever counts once).
        const existingRun = await client.query(
          `SELECT 1 FROM run_starts WHERE account_id = $1 AND run_key = $2`,
          [accountId, session.sessionId],
        );
        const insertedRun = await client.query(
          `INSERT INTO run_starts (account_id, run_key)
           VALUES ($1, $2)
           ON CONFLICT (account_id, run_key) DO NOTHING
           RETURNING run_key`,
          [accountId, session.sessionId],
        );
        runStarted = existingRun.rows.length === 0 && insertedRun.rows.length > 0;
        // Mirror into the durable lifetime trial ledger (see replaceNodeSessions).
        await client.query(
          `INSERT INTO trial_sessions (account_id, session_id)
           VALUES ($1, $2)
           ON CONFLICT (account_id, session_id) DO NOTHING`,
          [accountId, session.sessionId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return runStarted;
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
      attention: Array.isArray(row.attention) ? row.attention : undefined,
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
      attention: Array.isArray(row.attention) ? row.attention : undefined,
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

  async getEphemeralConfigs(accountId: string): Promise<EphemeralNodeConfig[]> {
    const { rows } = await this.query(`SELECT ephemeral_configs FROM accounts WHERE id = $1`, [accountId]);
    return normalizeEphemeralConfigs(rows[0]?.ephemeral_configs ?? null);
  }

  async setEphemeralConfigs(accountId: string, configs: EphemeralNodeConfig[]): Promise<EphemeralNodeConfig[]> {
    const normalized = normalizeEphemeralConfigs(configs);
    await this.query(`UPDATE accounts SET ephemeral_configs = $2 WHERE id = $1`, [accountId, JSON.stringify(normalized)]);
    return normalized;
  }

  async getQueueRouting(accountId: string): Promise<QueueRouting> {
    const { rows } = await this.query(`SELECT queue_routing FROM accounts WHERE id = $1`, [accountId]);
    return normalizeQueueRouting(rows[0]?.queue_routing ?? null);
  }

  async setQueueRouting(accountId: string, routing: QueueRouting): Promise<QueueRouting> {
    const normalized = normalizeQueueRouting(routing);
    await this.query(`UPDATE accounts SET queue_routing = $2 WHERE id = $1`, [accountId, JSON.stringify(normalized)]);
    return normalized;
  }

  // Seal plaintext hosted credentials into the at-rest form: every secret value
  // is an AES-256-GCM envelope bound to the account; ids stay in the clear.
  private sealHosted(accountId: string, h: HostedProvisioning): Record<string, unknown> {
    const out: Record<string, unknown> = { enabled: h.enabled };
    if (h.githubToken) out.githubToken = encryptSecret(accountId, h.githubToken);
    if (h.githubApp) {
      out.githubApp = {
        appId: h.githubApp.appId,
        installationId: h.githubApp.installationId,
        privateKeyPem: encryptSecret(accountId, h.githubApp.privateKeyPem),
      };
    }
    if (h.providerTokens && Object.keys(h.providerTokens).length) {
      const enc: Record<string, unknown> = {};
      for (const [p, t] of Object.entries(h.providerTokens)) enc[p] = encryptSecret(accountId, t);
      out.providerTokens = enc;
    }
    if (h.validatedProviders && Object.keys(h.validatedProviders).length) out.validatedProviders = h.validatedProviders;
    return out;
  }

  // Open the at-rest form back to plaintext. Tolerates legacy plaintext strings
  // (pre-encryption) on read; requires the master key for sealed values.
  private openHosted(accountId: string, stored: unknown): HostedProvisioning {
    if (!stored || typeof stored !== "object") return { ...DEFAULT_HOSTED_PROVISIONING };
    const s = stored as Record<string, any>;
    const dec = (v: unknown): string | undefined => {
      if (isSecretEnvelope(v)) return decryptSecret(accountId, v);
      if (typeof v === "string" && v) return v;
      return undefined;
    };
    const out: HostedProvisioning = { enabled: Boolean(s.enabled) };
    const gt = dec(s.githubToken);
    if (gt) out.githubToken = gt;
    if (s.githubApp && typeof s.githubApp === "object") {
      const pk = dec(s.githubApp.privateKeyPem);
      if (typeof s.githubApp.appId === "string" && typeof s.githubApp.installationId === "string" && pk) {
        out.githubApp = { appId: s.githubApp.appId, installationId: s.githubApp.installationId, privateKeyPem: pk };
      }
    }
    if (s.providerTokens && typeof s.providerTokens === "object") {
      const tokens: Record<string, string> = {};
      for (const [p, v] of Object.entries(s.providerTokens)) {
        const t = dec(v);
        if (t) tokens[p] = t;
      }
      if (Object.keys(tokens).length) out.providerTokens = tokens;
    }
    if (s.validatedProviders && typeof s.validatedProviders === "object") {
      const validated: Record<string, string> = {};
      for (const [provider, fingerprint] of Object.entries(s.validatedProviders)) {
        if (typeof fingerprint === "string") validated[provider] = fingerprint;
      }
      if (Object.keys(validated).length) out.validatedProviders = validated;
    }
    return out;
  }

  async getHostedProvisioning(accountId: string): Promise<HostedProvisioning> {
    const { rows } = await this.query(`SELECT hosted_provisioning FROM accounts WHERE id = $1`, [accountId]);
    return this.openHosted(accountId, rows[0]?.hosted_provisioning ?? null);
  }

  // Non-decrypting status read — reports which credentials are present without
  // needing the master key, so the settings UI works even if the key rotates.
  async getHostedProvisioningStatus(accountId: string): Promise<HostedProvisioningStatus> {
    const { rows } = await this.query(`SELECT hosted_provisioning FROM accounts WHERE id = $1`, [accountId]);
    const s = (rows[0]?.hosted_provisioning ?? {}) as Record<string, any>;
    const hasApp = Boolean(s.githubApp && s.githubApp.appId);
    return {
      enabled: Boolean(s.enabled),
      credential: hasApp ? "app" : s.githubToken ? "pat" : "none",
      githubAppId: hasApp ? String(s.githubApp.appId) : undefined,
      providers: s.providerTokens && typeof s.providerTokens === "object" ? Object.keys(s.providerTokens) : [],
      validatedProviders: s.validatedProviders && typeof s.validatedProviders === "object" ? Object.keys(s.validatedProviders) : [],
    };
  }

  async setHostedProvisioning(accountId: string, patch: Partial<HostedProvisioning>): Promise<HostedProvisioning> {
    const current = await this.getHostedProvisioning(accountId);
    const validatedProviders = { ...(current.validatedProviders ?? {}), ...(patch.validatedProviders ?? {}) };
    for (const [provider, token] of Object.entries(patch.providerTokens ?? {})) {
      if (validatedProviders[provider] !== providerCredentialFingerprint(token)) delete validatedProviders[provider];
    }
    // Merge provider tokens so adding one provider doesn't wipe the others.
    const merged = normalizeHostedProvisioning({
      ...current,
      ...patch,
      providerTokens: { ...(current.providerTokens ?? {}), ...(patch.providerTokens ?? {}) },
      validatedProviders,
    });
    // Encrypt at rest (throws if the master key is unset — fail closed).
    await this.query(`UPDATE accounts SET hosted_provisioning = $2 WHERE id = $1`, [accountId, JSON.stringify(this.sealHosted(accountId, merged))]);
    return merged;
  }

  async getHostedMachines(accountId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.query(`SELECT hosted_machines FROM accounts WHERE id = $1`, [accountId]);
    const v = rows[0]?.hosted_machines;
    return Array.isArray(v) ? v : [];
  }

  async setHostedMachines(accountId: string, machines: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    const arr = Array.isArray(machines) ? machines : [];
    await this.query(`UPDATE accounts SET hosted_machines = $2 WHERE id = $1`, [accountId, JSON.stringify(arr)]);
    return arr;
  }

  async listHostedMachineAccountIds(): Promise<string[]> {
    // Filter in JS: pg-mem (the dev/test backend) does not implement Postgres's
    // jsonb_typeof/jsonb_array_length functions, and this scan runs only on the
    // small account metadata rows (never session content).
    const { rows } = await this.query(`SELECT id, hosted_machines FROM accounts WHERE hosted_machines IS NOT NULL`);
    return rows.filter((row) => Array.isArray(row.hosted_machines) && row.hosted_machines.length > 0).map((row) => String(row.id));
  }

  async listReadyCapacityAccountIds(): Promise<string[]> {
    const { rows } = await this.query(`SELECT id, ephemeral_configs FROM accounts WHERE ephemeral_configs IS NOT NULL`);
    return rows.filter((row) => normalizeEphemeralConfigs(row.ephemeral_configs).some((config) => (config.readyCapacity ?? 0) > 0)).map((row) => String(row.id));
  }

  async acquireHostedProvisionLease(accountId: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const expiresAt = new Date(Date.now() + Math.max(30, ttlSeconds) * 1000).toISOString();
    const { rows } = await this.query(
      `INSERT INTO hosted_provision_leases (account_id, holder, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE
       SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE hosted_provision_leases.expires_at < now()
       RETURNING holder`,
      [accountId, holder, expiresAt],
    );
    return rows[0]?.holder === holder;
  }

  async releaseHostedProvisionLease(accountId: string, holder: string): Promise<void> {
    await this.query(`DELETE FROM hosted_provision_leases WHERE account_id = $1 AND holder = $2`, [accountId, holder]);
  }

  async appendHostedAudit(accountId: string, event: HostedAuditEvent): Promise<void> {
    const { rows } = await this.query(`SELECT hosted_audit FROM accounts WHERE id = $1`, [accountId]);
    const cur = Array.isArray(rows[0]?.hosted_audit) ? (rows[0].hosted_audit as HostedAuditEvent[]) : [];
    const next = [...cur, event].slice(-200); // cap the trail
    await this.query(`UPDATE accounts SET hosted_audit = $2 WHERE id = $1`, [accountId, JSON.stringify(next)]);
  }

  async listHostedAudit(accountId: string, limit = 50): Promise<HostedAuditEvent[]> {
    const { rows } = await this.query(`SELECT hosted_audit FROM accounts WHERE id = $1`, [accountId]);
    const cur = Array.isArray(rows[0]?.hosted_audit) ? (rows[0].hosted_audit as HostedAuditEvent[]) : [];
    return cur.slice(-limit).reverse();
  }

  async getModelAuthVault(accountId: string): Promise<ModelAuthVault | undefined> {
    const { rows } = await this.query(`SELECT * FROM model_auth_vaults WHERE account_id = $1`, [accountId]);
    const row = rows[0];
    if (!row) return undefined;
    return { ciphertext: row.ciphertext, updatedAt: new Date(row.updated_at).toISOString(), updatedByNodeId: row.updated_by_node_id, needsRotation: Boolean(row.needs_rotation) };
  }

  async getHostedModelAuthVaultKey(accountId: string): Promise<SecretEnvelope | undefined> {
    const { rows } = await this.query(`SELECT key_enc FROM hosted_model_auth_keys WHERE account_id = $1`, [accountId]);
    if (!rows[0]) return undefined;
    const raw = rows[0].key_enc;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as SecretEnvelope;
  }

  async setHostedModelAuthVaultKey(accountId: string, enc: SecretEnvelope): Promise<void> {
    await this.query(
      `INSERT INTO hosted_model_auth_keys (account_id, key_enc, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (account_id) DO UPDATE SET key_enc = EXCLUDED.key_enc, updated_at = now()`,
      [accountId, JSON.stringify(enc)],
    );
  }

  async setModelAuthVault(accountId: string, nodeId: string, ciphertext: string, rotated = false): Promise<ModelAuthVault> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize all generation writers on the account row. The lock makes the
      // check + generation flip atomic: exactly one survivor can consume a
      // rotation flag, and a stale-key writer cannot clear it accidentally.
      const current = await client.query(
        `SELECT needs_rotation FROM model_auth_vaults WHERE account_id = $1 FOR UPDATE`,
        [accountId],
      );
      if (current.rows[0] && Boolean(current.rows[0].needs_rotation) !== rotated) {
        throw Object.assign(new Error(rotated
          ? "Model-auth vault was already rotated by another node"
          : "Model-auth vault key rotation is required before this vault can be updated"), { status: 409 });
      }
      const { rows } = await client.query(
        `INSERT INTO model_auth_vaults (account_id, ciphertext, updated_by_node_id, updated_at, needs_rotation)
         VALUES ($1, $2, $3, now(), false)
         ON CONFLICT (account_id) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext, updated_by_node_id = EXCLUDED.updated_by_node_id, updated_at = now(), needs_rotation = false
         RETURNING *`,
        [accountId, ciphertext, nodeId],
      );
      if (rotated) {
        // Every old wrap protects the removed node's generation. Drop them all
        // and queue fresh wraps only for currently-enrolled nodes. Keep this in
        // the same transaction as the generation flip: no stale-key writer can
        // slip in after needs_rotation clears but before old wraps disappear.
        await client.query(`DELETE FROM model_auth_wrapped_keys WHERE account_id = $1`, [accountId]);
        await client.query(
        `INSERT INTO model_auth_key_requests (account_id, node_id, public_key, created_at)
         SELECT k.account_id, k.node_id, k.public_key, now()
         FROM model_auth_node_keys k
         JOIN nodes n ON n.id = k.node_id AND n.account_id = k.account_id
         WHERE k.account_id = $1 AND k.node_id <> $2
         ON CONFLICT (account_id, node_id) DO UPDATE SET public_key = EXCLUDED.public_key, created_at = now()`,
          [accountId, nodeId],
        );
      }
      await client.query("COMMIT");
      return { ciphertext: rows[0].ciphertext, updatedAt: new Date(rows[0].updated_at).toISOString(), updatedByNodeId: rows[0].updated_by_node_id, needsRotation: Boolean(rows[0].needs_rotation) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  // --- GitHub App private-key vault (issue #88) -------------------------

  async listGithubAppVaults(accountId: string): Promise<GithubAppVault[]> {
    const { rows } = await this.query(`SELECT * FROM github_app_vaults WHERE account_id = $1`, [accountId]);
    return rows.map((row: any) => ({
      appId: row.app_id,
      ciphertext: row.ciphertext,
      updatedByNodeId: row.updated_by_node_id,
      needsRotation: Boolean(row.needs_rotation),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async setGithubAppVault(accountId: string, appId: string, nodeId: string, ciphertext: string): Promise<GithubAppVault> {
    // A push always clears needs_rotation: whether this is the very first sync
    // or a response to a rotation request, the caller is about to be encrypting
    // under a vault key only nodes that pull AFTER this write will ever see.
    const { rows } = await this.query(
      `INSERT INTO github_app_vaults (account_id, app_id, ciphertext, updated_by_node_id, needs_rotation, updated_at)
       VALUES ($1, $2, $3, $4, false, now())
       ON CONFLICT (account_id, app_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_by_node_id = EXCLUDED.updated_by_node_id, needs_rotation = false, updated_at = now()
       RETURNING *`,
      [accountId, appId, ciphertext, nodeId],
    );
    const row = rows[0];
    return { appId: row.app_id, ciphertext: row.ciphertext, updatedByNodeId: row.updated_by_node_id, needsRotation: false, updatedAt: new Date(row.updated_at).toISOString() };
  }

  async listGithubAppWrappedKeysForNode(accountId: string, nodeId: string): Promise<GithubAppWrappedKey[]> {
    const { rows } = await this.query(`SELECT * FROM github_app_wrapped_keys WHERE account_id = $1 AND node_id = $2`, [accountId, nodeId]);
    return rows.map((row: any) => ({
      appId: row.app_id,
      nodeId: row.node_id,
      wrappedKey: row.wrapped_key,
      wrappedByNodeId: row.wrapped_by_node_id,
      wrappedByPublicKey: row.wrapped_by_public_key,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async requestGithubAppWrappedKey(accountId: string, appId: string, nodeId: string, publicKey: string): Promise<void> {
    const { rows } = await this.query(`SELECT 1 FROM github_app_wrapped_keys WHERE account_id = $1 AND app_id = $2 AND node_id = $3`, [accountId, appId, nodeId]);
    if (rows[0]) return; // already have a wrapped key for this app — nothing to request
    await this.query(
      `INSERT INTO github_app_key_requests (account_id, app_id, node_id, public_key, created_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (account_id, app_id, node_id) DO UPDATE SET public_key = EXCLUDED.public_key, created_at = now()`,
      [accountId, appId, nodeId, publicKey],
    );
  }

  async listGithubAppKeyRequests(accountId: string, exceptNodeId: string): Promise<GithubAppKeyRequest[]> {
    const { rows } = await this.query(
      `SELECT app_id, node_id, public_key, created_at FROM github_app_key_requests WHERE account_id = $1 AND node_id <> $2 ORDER BY created_at ASC`,
      [accountId, exceptNodeId],
    );
    return rows.map((row: any) => ({ appId: row.app_id, nodeId: row.node_id, publicKey: row.public_key, createdAt: new Date(row.created_at).toISOString() }));
  }

  async setGithubAppWrappedKey(
    accountId: string,
    appId: string,
    targetNodeId: string,
    wrappedByNodeId: string,
    wrappedByPublicKey: string,
    wrappedKey: string,
  ): Promise<GithubAppWrappedKey> {
    const { rows } = await this.query(
      `INSERT INTO github_app_wrapped_keys (account_id, app_id, node_id, wrapped_key, wrapped_by_node_id, wrapped_by_public_key, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (account_id, app_id, node_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key, wrapped_by_node_id = EXCLUDED.wrapped_by_node_id, wrapped_by_public_key = EXCLUDED.wrapped_by_public_key, updated_at = now()
       RETURNING *`,
      [accountId, appId, targetNodeId, wrappedKey, wrappedByNodeId, wrappedByPublicKey],
    );
    await this.query(`DELETE FROM github_app_key_requests WHERE account_id = $1 AND app_id = $2 AND node_id = $3`, [accountId, appId, targetNodeId]);
    const row = rows[0];
    return {
      appId: row.app_id,
      nodeId: row.node_id,
      wrappedKey: row.wrapped_key,
      wrappedByNodeId: row.wrapped_by_node_id,
      wrappedByPublicKey: row.wrapped_by_public_key,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  // --- Device→device provider-token vault (P2 / Gap A) -----------------

  async getDeviceVault(accountId: string): Promise<DeviceVault | undefined> {
    const { rows } = await this.query(`SELECT * FROM device_vaults WHERE account_id = $1`, [accountId]);
    const row = rows[0];
    if (!row) return undefined;
    return { ciphertext: row.ciphertext, updatedByDevice: row.updated_by_device, updatedAt: new Date(row.updated_at).toISOString() };
  }

  async setDeviceVault(accountId: string, byDevicePublicKey: string, ciphertext: string): Promise<DeviceVault> {
    const { rows } = await this.query(
      `INSERT INTO device_vaults (account_id, ciphertext, updated_by_device, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_by_device = EXCLUDED.updated_by_device, updated_at = now()
       RETURNING *`,
      [accountId, ciphertext, byDevicePublicKey],
    );
    return { ciphertext: rows[0].ciphertext, updatedByDevice: rows[0].updated_by_device, updatedAt: new Date(rows[0].updated_at).toISOString() };
  }

  async getDeviceVaultWrappedKey(accountId: string, devicePublicKey: string): Promise<DeviceVaultWrappedKeyRecord | undefined> {
    const { rows } = await this.query(`SELECT * FROM device_vault_wrapped_keys WHERE account_id = $1 AND device_pub = $2`, [accountId, devicePublicKey]);
    const row = rows[0];
    if (!row) return undefined;
    return { devicePublicKey: row.device_pub, wrappedKey: row.wrapped_key, wrappedByPublicKey: row.wrapped_by_public_key, updatedAt: new Date(row.updated_at).toISOString() };
  }

  async requestDeviceVaultWrappedKey(accountId: string, devicePublicKey: string): Promise<void> {
    if (await this.getDeviceVaultWrappedKey(accountId, devicePublicKey)) return;
    await this.query(
      `INSERT INTO device_vault_key_requests (account_id, device_pub, created_at)
       VALUES ($1, $2, now())
       ON CONFLICT (account_id, device_pub) DO UPDATE SET created_at = now()`,
      [accountId, devicePublicKey],
    );
  }

  async listDeviceVaultKeyRequests(accountId: string, exceptDevicePublicKey: string): Promise<DeviceVaultKeyRequest[]> {
    const { rows } = await this.query(
      `SELECT device_pub, created_at FROM device_vault_key_requests WHERE account_id = $1 AND device_pub <> $2 ORDER BY created_at ASC`,
      [accountId, exceptDevicePublicKey],
    );
    return rows.map((row: any) => ({ devicePublicKey: row.device_pub, createdAt: new Date(row.created_at).toISOString() }));
  }

  async setDeviceVaultWrappedKey(accountId: string, targetDevicePublicKey: string, wrappedByPublicKey: string, wrappedKey: string): Promise<DeviceVaultWrappedKeyRecord> {
    const { rows } = await this.query(
      `INSERT INTO device_vault_wrapped_keys (account_id, device_pub, wrapped_key, wrapped_by_public_key, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (account_id, device_pub) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key, wrapped_by_public_key = EXCLUDED.wrapped_by_public_key, updated_at = now()
       RETURNING *`,
      [accountId, targetDevicePublicKey, wrappedKey, wrappedByPublicKey],
    );
    await this.query(`DELETE FROM device_vault_key_requests WHERE account_id = $1 AND device_pub = $2`, [accountId, targetDevicePublicKey]);
    return { devicePublicKey: rows[0].device_pub, wrappedKey: rows[0].wrapped_key, wrappedByPublicKey: rows[0].wrapped_by_public_key, updatedAt: new Date(rows[0].updated_at).toISOString() };
  }

  // --- Durable E2E session snapshots (Gap B) ---------------------------

  async getSessionSnapshot(accountId: string, sessionId: string): Promise<SessionSnapshotRecord | undefined> {
    const { rows } = await this.query(`SELECT * FROM session_snapshots WHERE account_id = $1 AND session_id = $2`, [accountId, sessionId]);
    const row = rows[0];
    if (!row) return undefined;
    return { sessionId: row.session_id, ciphertext: row.ciphertext, updatedAt: new Date(row.updated_at).toISOString() };
  }

  async setSessionSnapshot(accountId: string, sessionId: string, ciphertext: string): Promise<SessionSnapshotRecord> {
    const { rows } = await this.query(
      `INSERT INTO session_snapshots (account_id, session_id, ciphertext, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, session_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
       RETURNING *`,
      [accountId, sessionId, ciphertext],
    );
    return { sessionId: rows[0].session_id, ciphertext: rows[0].ciphertext, updatedAt: new Date(rows[0].updated_at).toISOString() };
  }

  async deleteSessionSnapshot(accountId: string, sessionId: string): Promise<void> {
    await this.query(`DELETE FROM session_snapshots WHERE account_id = $1 AND session_id = $2`, [accountId, sessionId]);
  }

  // --- Session↔machine correlation for rebuild-after-teardown (Gap 1) --------

  private mapSessionCorrelation(row: any): SessionCorrelation {
    return {
      sessionId: String(row.session_id),
      nodeId: String(row.node_id),
      provider: String(row.provider),
      region: row.region ?? undefined,
      ttlMinutes: row.ttl_minutes != null ? Number(row.ttl_minutes) : undefined,
      repo: row.repo ?? undefined,
      setupId: row.setup_id ?? undefined,
      machineId: row.machine_id ?? undefined,
      app: row.app ?? undefined,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async getSessionCorrelation(accountId: string, sessionId: string): Promise<SessionCorrelation | undefined> {
    const { rows } = await this.query(`SELECT * FROM session_correlation WHERE account_id = $1 AND session_id = $2`, [accountId, sessionId]);
    return rows[0] ? this.mapSessionCorrelation(rows[0]) : undefined;
  }

  async listSessionCorrelations(accountId: string): Promise<SessionCorrelation[]> {
    const { rows } = await this.query(`SELECT * FROM session_correlation WHERE account_id = $1 ORDER BY updated_at DESC`, [accountId]);
    return rows.map((r) => this.mapSessionCorrelation(r));
  }

  async setSessionCorrelation(accountId: string, input: SessionCorrelationInput): Promise<SessionCorrelation> {
    const { rows } = await this.query(
      `INSERT INTO session_correlation
         (account_id, session_id, node_id, provider, region, ttl_minutes, repo, setup_id, machine_id, app, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (account_id, session_id) DO UPDATE SET
         node_id = EXCLUDED.node_id, provider = EXCLUDED.provider, region = EXCLUDED.region,
         ttl_minutes = EXCLUDED.ttl_minutes, repo = EXCLUDED.repo, setup_id = EXCLUDED.setup_id,
         machine_id = EXCLUDED.machine_id, app = EXCLUDED.app, updated_at = now()
       RETURNING *`,
      [
        accountId, input.sessionId, input.nodeId, input.provider,
        input.region ?? null, input.ttlMinutes ?? null, input.repo ?? null,
        input.setupId ?? null, input.machineId ?? null, input.app ?? null,
      ],
    );
    return this.mapSessionCorrelation(rows[0]);
  }

  async deleteSessionCorrelation(accountId: string, sessionId: string): Promise<void> {
    await this.query(`DELETE FROM session_correlation WHERE account_id = $1 AND session_id = $2`, [accountId, sessionId]);
  }

  async getNodeRoomKeyEnc(accountId: string, nodeId: string): Promise<SecretEnvelope | undefined> {
    const { rows } = await this.query(`SELECT room_key_enc FROM node_room_keys WHERE account_id = $1 AND node_id = $2`, [accountId, nodeId]);
    if (!rows[0]) return undefined;
    const raw = rows[0].room_key_enc;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as SecretEnvelope;
  }

  async setNodeRoomKeyEnc(accountId: string, nodeId: string, enc: SecretEnvelope): Promise<void> {
    await this.query(
      `INSERT INTO node_room_keys (account_id, node_id, room_key_enc, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, node_id) DO UPDATE SET room_key_enc = EXCLUDED.room_key_enc, updated_at = now()`,
      [accountId, nodeId, JSON.stringify(enc)],
    );
  }

  async findSessionByIssue(accountId: string, repo: string, issueNumber: number): Promise<{ sessionId: string; nodeId: string } | undefined> {
    // The node advertises issue sessions with source "issue:owner/repo#N".
    const source = `issue:${repo}#${issueNumber}`;
    const { rows } = await this.query(
      `SELECT session_id, node_id FROM session_index WHERE account_id = $1 AND source = $2 ORDER BY updated_at DESC LIMIT 1`,
      [accountId, source],
    );
    return rows[0] ? { sessionId: String(rows[0].session_id), nodeId: String(rows[0].node_id) } : undefined;
  }

  async findSessionByExternalId(accountId: string, externalId: string): Promise<{ sessionId: string; nodeId: string } | undefined> {
    // The node advertises a Linear-issue session with source "linear:<externalId>".
    const source = `linear:${externalId}`;
    const { rows } = await this.query(
      `SELECT session_id, node_id FROM session_index WHERE account_id = $1 AND source = $2 ORDER BY updated_at DESC LIMIT 1`,
      [accountId, source],
    );
    return rows[0] ? { sessionId: String(rows[0].session_id), nodeId: String(rows[0].node_id) } : undefined;
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

  async listInboundHooks(accountId: string, kind?: string): Promise<InboundHook[]> {
    const { rows } = kind
      ? await this.query(
          `SELECT * FROM inbound_hooks WHERE account_id = $1 AND kind = $2 ORDER BY created_at DESC`,
          [accountId, kind],
        )
      : await this.query(`SELECT * FROM inbound_hooks WHERE account_id = $1 ORDER BY created_at DESC`, [accountId]);
    return rows.map(mapHook);
  }

  async getInboundHook(id: string): Promise<InboundHook | undefined> {
    const { rows } = await this.query(`SELECT * FROM inbound_hooks WHERE id = $1`, [id]);
    return rows[0] ? mapHook(rows[0]) : undefined;
  }

  async setInboundHookSecret(accountId: string, id: string, secret: string): Promise<InboundHook | undefined> {
    const { rows } = await this.query(
      `UPDATE inbound_hooks SET secret = $3, updated_at = now() WHERE id = $2 AND account_id = $1 RETURNING *`,
      [accountId, id, secret],
    );
    return rows[0] ? mapHook(rows[0]) : undefined;
  }

  async updateInboundHook(
    accountId: string,
    id: string,
    patch: { enabled?: boolean; templateInstruction?: string; routingDefault?: string },
  ): Promise<InboundHook | undefined> {
    const { rows } = await this.query(
      `UPDATE inbound_hooks
       SET enabled = CASE WHEN $3 THEN $4 ELSE enabled END,
           template_instruction = CASE WHEN $5 THEN $6 ELSE template_instruction END,
           routing_default = CASE WHEN $7 THEN $8 ELSE routing_default END,
           updated_at = now()
       WHERE id = $2 AND account_id = $1 RETURNING *`,
      [
        accountId,
        id,
        patch.enabled !== undefined,
        patch.enabled ?? null,
        patch.templateInstruction !== undefined,
        patch.templateInstruction?.trim() || null,
        patch.routingDefault !== undefined,
        patch.routingDefault?.trim() || null,
      ],
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

  async setInboundHookTriggerAccess(
    accountId: string,
    id: string,
    triggerAccess: "everyone" | "contributor" | "collaborator" | undefined,
  ): Promise<InboundHook | undefined> {
    // "everyone" is stored as NULL (same as unset) — it's the no-restriction
    // default, so there's nothing meaningful to distinguish it from "never set".
    const value = triggerAccess === "contributor" || triggerAccess === "collaborator" ? triggerAccess : null;
    const { rows } = await this.query(
      `UPDATE inbound_hooks SET trigger_access = $3 WHERE id = $2 AND account_id = $1 RETURNING *`,
      [accountId, id, value],
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
    const run = await this.enqueueAutomationRun(accountId, input);
    const { rows } = await this.query(`SELECT * FROM work_items WHERE account_id = $1 AND id = $2`, [accountId, run.id]);
    return mapWorkItem(rows[0]);
  }

  async createAutomationDefinition(
    accountId: string,
    input: Omit<AutomationDefinition, "id" | "accountId" | "createdAt" | "updatedAt">,
  ): Promise<AutomationDefinition> {
    const { rows } = await this.query(
      `INSERT INTO automation_definitions
      (id, account_id, name, template_ciphertext, runtime_id, model, node_label, ephemeral,
       approval_mode, sandbox, enabled, schedule, next_run_at, trigger, webhook_secret, repo,
       labels, repos, template_id, on_events, target_kind, target_session_id, message, config_key, config_order, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
      [`automation_${randomUUID()}`, accountId, input.name, input.templateCiphertext ?? null,
        input.runtimeId ?? null, input.model ?? null, input.nodeLabel ?? null, input.ephemeral ?? null,
        input.approvalMode ?? null, input.sandbox ?? null, input.enabled ?? false,
        JSON.stringify(input.schedule ?? { kind: "once", at: "9999-12-31T00:00:00.000Z" }), input.nextRunAt ?? null,
        input.trigger ?? null, input.webhookSecret ?? null, input.repo ?? null,
        input.labels ? JSON.stringify(input.labels) : null,
        input.repos ? JSON.stringify(input.repos) : null,
        input.templateId ?? null,
        input.on ? JSON.stringify(input.on) : null,
        input.target?.kind === "existing_session" ? input.target.kind : null,
        input.target?.kind === "existing_session" ? input.target.sessionId : null,
        input.message ?? false,
        input.configKey ?? null,
        input.configOrder ?? null,
        input.maxAttempts ?? null],
    );
    return mapAutomationDefinition(rows[0]);
  }

  async getAutomationDefinition(accountId: string, id: string): Promise<AutomationDefinition | undefined> {
    const { rows } = await this.query(
      `SELECT * FROM automation_definitions WHERE account_id = $1 AND id = $2`,
      [accountId, id],
    );
    return rows[0] ? mapAutomationDefinition(rows[0]) : undefined;
  }

  async getAutomationDefinitionById(id: string): Promise<AutomationDefinition | undefined> {
    const { rows } = await this.query(
      `SELECT * FROM automation_definitions WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapAutomationDefinition(rows[0]) : undefined;
  }

  async updateAutomationDefinition(
    accountId: string,
    id: string,
    input: Partial<Omit<AutomationDefinition, "id" | "accountId" | "createdAt" | "updatedAt" | "lastScheduledAt">>,
  ): Promise<AutomationDefinition | undefined> {
    const current = await this.getAutomationDefinition(accountId, id);
    if (!current) return undefined;
    const next = { ...current, ...input };
    const { rows } = await this.query(
      `UPDATE automation_definitions SET name=$3, template_ciphertext=$4, runtime_id=$5,
       model=$6, node_label=$7, ephemeral=$8, approval_mode=$9, sandbox=$10,
       enabled=$11, schedule=$12, next_run_at=$13, trigger=$14, webhook_secret=$15,
       repo=$16, labels=$17, repos=$18, template_id=$19, on_events=$20,
       target_kind=$21, target_session_id=$22, message=$23, config_key=$24,
       config_order=$25, max_attempts=$26, updated_at=now()
       WHERE account_id=$1 AND id=$2 RETURNING *`,
      [accountId, id, next.name, next.templateCiphertext ?? null, next.runtimeId ?? null,
        next.model ?? null, next.nodeLabel ?? null, next.ephemeral ?? null,
        next.approvalMode ?? null, next.sandbox ?? null, next.enabled ?? false,
        JSON.stringify(next.schedule ?? { kind: "once", at: "9999-12-31T00:00:00.000Z" }), next.nextRunAt ?? null,
        next.trigger ?? null, next.webhookSecret ?? null, next.repo ?? null,
        next.labels ? JSON.stringify(next.labels) : null,
        next.repos ? JSON.stringify(next.repos) : null,
        next.templateId ?? null,
        next.on ? JSON.stringify(next.on) : null,
        next.target?.kind === "existing_session" ? next.target.kind : null,
        next.target?.kind === "existing_session" ? next.target.sessionId : null,
        next.message ?? false,
        next.configKey ?? null,
        next.configOrder ?? null,
        next.maxAttempts ?? null],
    );
    return rows[0] ? mapAutomationDefinition(rows[0]) : undefined;
  }

  async deleteAutomationDefinition(accountId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.query(
      `DELETE FROM automation_definitions WHERE account_id=$1 AND id=$2`,
      [accountId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async listAutomationDefinitions(accountId: string): Promise<AutomationDefinition[]> {
    const { rows } = await this.query(
      `SELECT * FROM automation_definitions WHERE account_id = $1 ORDER BY created_at DESC`,
      [accountId],
    );
    return rows.map(mapAutomationDefinition);
  }

  async listDueAutomationDefinitions(nowIso: string, limit = 100): Promise<AutomationDefinition[]> {
    // Filter and bound in SQL so the partial index idx_automation_definitions_due
    // is used and the scan is proportional to due rows, not total-enabled rows.
    // `next_run_at <= $1` already excludes NULLs (NULL comparisons are never
    // true), so no separate IS NOT NULL is needed.
    const { rows } = await this.query(
      `SELECT * FROM automation_definitions
       WHERE enabled=true AND next_run_at <= $1
       ORDER BY next_run_at ASC
       LIMIT $2`,
      [new Date(nowIso), Math.max(1, Math.min(500, limit))],
    );
    return rows.map(mapAutomationDefinition);
  }

  async enqueueScheduledOccurrence(
    accountId: string,
    definitionId: string,
    occurrenceIso: string,
    nextRunAt?: string,
  ): Promise<AutomationRun | undefined> {
    const definition = await this.getAutomationDefinition(accountId, definitionId);
    if (!definition || !definition.enabled || definition.nextRunAt !== occurrenceIso) return undefined;
    const run = await this.enqueueAutomationRun(accountId, {
      source: "schedule",
      title: definition.name,
      body: definition.templateCiphertext,
      definitionId,
      triggerKind: "schedule",
      dedupeKey: `schedule:${definitionId}:${occurrenceIso}`,
      label: definition.nodeLabel,
      runtimeId: definition.runtimeId,
      model: definition.model,
      approvalMode: definition.approvalMode,
      sandbox: definition.sandbox,
      target: definition.target,
      message: definition.message,
      // Schedule ticks do not name a repo — use the binding's workspace target.
      repo: definition.repo,
    });
    // Optimistic advance is the scheduler lease: only one scheduler instance can
    // move this exact occurrence. The unique dedupe key separately guarantees
    // that a crash after INSERT but before UPDATE cannot duplicate the run.
    const { rowCount } = await this.query(
      `UPDATE automation_definitions SET last_scheduled_at=$4, next_run_at=$5,
       enabled=CASE WHEN $5::text IS NULL THEN false ELSE enabled END, updated_at=now()
       WHERE account_id=$1 AND id=$2 AND enabled=true AND next_run_at=$3`,
      [accountId, definitionId, new Date(occurrenceIso), new Date(occurrenceIso), nextRunAt ? new Date(nextRunAt) : null],
    );
    return (rowCount ?? 0) > 0 ? run : undefined;
  }

  async listTriggerEvents(accountId: string, limit = 50): Promise<TriggerEvent[]> {
    const { rows } = await this.query(
      `SELECT * FROM trigger_events WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [accountId, Math.max(1, Math.min(200, limit))],
    );
    return rows.map(mapTriggerEvent);
  }

  async getAutomationRunBySourceKey(accountId: string, sourceKey: string): Promise<AutomationRun | undefined> {
    const { rows } = await this.query(
      `SELECT w.* FROM work_items w
       JOIN trigger_events t ON t.id = w.trigger_id
       WHERE w.account_id = $1 AND t.account_id = $1 AND t.source_key = $2
       LIMIT 1`,
      [accountId, sourceKey],
    );
    return rows[0] ? mapAutomationRun(rows[0]) : undefined;
  }

  async enqueueAutomationRun(accountId: string, input: WorkItemInput): Promise<AutomationRun> {
    return (await this.enqueueAutomationRunWithResult(accountId, input)).run;
  }

  async enqueueAutomationRunWithResult(
    accountId: string,
    input: WorkItemInput,
  ): Promise<{ run: AutomationRun; created: boolean }> {
    const dedupeKey = input.dedupeKey ?? null;
    const collapseKey = input.collapseKey ?? null;
    let definition: AutomationDefinition | undefined;
    if (input.definitionId) {
      const found = await this.query(
        `SELECT * FROM automation_definitions WHERE account_id = $1 AND id = $2`,
        [accountId, input.definitionId],
      );
      if (!found.rows[0]) throw Object.assign(new Error("Unknown automation definition"), { status: 404 });
      definition = mapAutomationDefinition(found.rows[0]);
    }
    const triggerKind = triggerKindForSource(input.triggerKind, input.source);
    const triggerId = `trigger_${randomUUID()}`;
    // Prefer an explicit per-run repo (event / caller); fall back to the
    // definition's workspace target so schedule/webhook/manual stay consistent.
    const repo = input.repo ?? definition?.repo;
    const sourceRef = {
      ...(repo ? { repo } : {}),
      ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
    };
    const trigger = await this.query(
      `INSERT INTO trigger_events (id, account_id, kind, source_key, source_ref)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [triggerId, accountId, triggerKind, dedupeKey, JSON.stringify(sourceRef)],
    );
    let canonicalTriggerId = trigger.rows[0]?.id as string | undefined;
    if (!canonicalTriggerId && dedupeKey) {
      const existing = await this.query(
        `SELECT id FROM trigger_events WHERE account_id = $1 AND source_key = $2`,
        [accountId, dedupeKey],
      );
      canonicalTriggerId = existing.rows[0]?.id;
    }
    canonicalTriggerId ??= triggerId;
    const target = input.target ?? { kind: "new_session" as const };
    // Two partial-unique constraints can fire: the per-delivery dedupe key and the
    // per-issue collapse key (only against the still-pending row). ON CONFLICT DO
    // NOTHING covers both; on either conflict we return the existing item.
    const triggeredEvent: RunEvidenceEvent = {
      at: new Date().toISOString(),
      kind: "triggered",
      summary: "Automation run created.",
      ref: repo && input.issueNumber !== undefined ? `${repo}#${input.issueNumber}` : repo,
      url: input.url,
    };
    const { rows } = await this.query(
      `INSERT INTO work_items (id, account_id, label, source, status, title, body, repo, issue_number, url, external_id, dedupe_key, collapse_key, default_routed, runtime_id, model, installation_id, app_id, definition_id, trigger_id, trigger_kind, target_kind, target_session_id, message, ephemeral, approval_mode, sandbox, max_attempts, events, event_context)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28::jsonb, $29)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        `work_${randomUUID()}`,
        accountId,
        normalizeWorkLabel(input.label ?? definition?.nodeLabel),
        input.source,
        input.title,
        input.body ?? null,
        repo ?? null,
        input.issueNumber ?? null,
        input.url ?? null,
        input.externalId ?? null,
        dedupeKey,
        collapseKey,
        input.defaultRouted ?? null,
        input.runtimeId ?? definition?.runtimeId ?? null,
        input.model ?? definition?.model ?? null,
        input.installationId ?? null,
        input.appId ?? null,
        input.definitionId ?? null,
        canonicalTriggerId,
        triggerKind,
        target.kind,
        target.kind === "existing_session" ? target.sessionId : null,
        input.message ?? definition?.message ?? false,
        input.ephemeral ?? definition?.ephemeral ?? null,
        input.approvalMode ?? definition?.approvalMode ?? null,
        input.sandbox ?? definition?.sandbox ?? null,
        input.maxAttempts ?? definition?.maxAttempts ?? null,
        JSON.stringify([triggeredEvent]),
        input.eventContext ?? null,
      ],
    );
    if (rows[0]) return { run: mapAutomationRun(rows[0]), created: true };
    // Conflict: a redelivery (dedupe key) or another delivery for an issue that
    // already has a pending item (collapse key). Return the existing one so the
    // caller stays idempotent and no duplicate lands in the queue.
    if (dedupeKey) {
      const existing = await this.query(
        `SELECT * FROM work_items WHERE account_id = $1 AND dedupe_key = $2 LIMIT 1`,
        [accountId, dedupeKey],
      );
      if (existing.rows[0]) return { run: mapAutomationRun(existing.rows[0]), created: false };
    }
    const existingPending = await this.query(
      `SELECT * FROM work_items WHERE account_id = $1 AND collapse_key = $2 AND status = 'pending' LIMIT 1`,
      [accountId, collapseKey],
    );
    return { run: mapAutomationRun(existingPending.rows[0]), created: false };
  }

  async getAutomationRun(accountId: string, id: string): Promise<AutomationRun | undefined> {
    const { rows } = await this.query(`SELECT * FROM work_items WHERE account_id = $1 AND id = $2`, [accountId, id]);
    return rows[0] ? mapAutomationRun(rows[0]) : undefined;
  }

  async listAutomationRuns(accountId: string, limit = 50): Promise<AutomationRun[]> {
    const { rows } = await this.query(
      `SELECT * FROM work_items WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [accountId, Math.max(1, Math.min(200, limit))],
    );
    return rows.map(mapAutomationRun);
  }

  async cancelAutomationRun(accountId: string, id: string): Promise<CancelAutomationRunResult | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The account predicate makes unknown and cross-account ids identical. The
      // row lock serializes cancellation with another cancellation/transition,
      // so the status, bounded event, completion timestamp, and lease release
      // are one durable operation.
      const selected = await client.query(
        `SELECT * FROM work_items WHERE account_id = $1 AND id = $2 FOR UPDATE`,
        [accountId, id],
      );
      const current = selected.rows[0];
      if (!current) {
        await client.query("COMMIT");
        return undefined;
      }
      const previousStatus = current.status as AutomationRunStatus;
      if (previousStatus === "cancelled" || previousStatus === "succeeded" || previousStatus === "failed") {
        await client.query("COMMIT");
        return { run: mapAutomationRun(current), previousStatus, transitioned: false };
      }
      if (!["pending", "claimed", "running", "needs_attention"].includes(previousStatus)) {
        await client.query("COMMIT");
        return { run: mapAutomationRun(current), previousStatus, transitioned: false };
      }
      const events = [
        ...(current.events ?? []),
        { at: new Date().toISOString(), kind: "cancelled", summary: "Automation run cancelled." },
      ].slice(-100);
      const updated = await client.query(
        `UPDATE work_items SET status = 'cancelled', completed_at = COALESCE(completed_at, now()),
         lease_expires_at = NULL, events = $3::jsonb
         WHERE account_id = $1 AND id = $2 RETURNING *`,
        [accountId, id, JSON.stringify(events)],
      );
      // Keep claimed_by_node_id as a privacy-safe ownership tombstone. It lets
      // only that node's heartbeat distinguish cancellation from a generic lost
      // lease while the actual renewable lease above is always cleared.
      await client.query("COMMIT");
      return { run: mapAutomationRun(updated.rows[0]), previousStatus, transitioned: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async retryAutomationRun(accountId: string, id: string): Promise<RetryAutomationRunResult | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT * FROM work_items WHERE account_id = $1 AND id = $2 FOR UPDATE`,
        [accountId, id],
      );
      const current = selected.rows[0];
      if (!current) { await client.query("COMMIT"); return undefined; }
      const checks = Array.isArray(current.checks) ? current.checks : [];
      const output = current.output ?? {};
      const events = Array.isArray(current.events) ? current.events : [];
      const failedCheck = checks.some((check: RunCheck) => check.status === "failed");
      const explicitNoChanges = events.some((event: RunEvidenceEvent) => /no (file )?changes/i.test(event.summary));
      const hasArtifact = Boolean(output.branch || output.commit || output.prUrl || output.checkpoint || output.artifactUrl);
      const ambiguousSuccess = current.status === "succeeded" && !failedCheck && !explicitNoChanges && !hasArtifact;
      const eligible = current.status === "failed" || failedCheck || ambiguousSuccess;
      if (!eligible) {
        await client.query("COMMIT");
        return { run: mapAutomationRun(current), transitioned: false, reason: "not_retryable" };
      }
      const attempt = Math.max(1, Number(current.attempt ?? 1));
      const maxAttempts = Number(current.max_attempts);
      if (Number.isFinite(maxAttempts) && maxAttempts > 0 && attempt >= maxAttempts) {
        await client.query("COMMIT");
        return { run: mapAutomationRun(current), transitioned: false, reason: "attempt_limit" };
      }
      if (current.collapse_key) {
        const pending = await client.query(
          `SELECT id FROM work_items WHERE account_id = $1 AND collapse_key = $2 AND status = 'pending' AND id <> $3 LIMIT 1`,
          [accountId, current.collapse_key, id],
        );
        if (pending.rows[0]) {
          await client.query("COMMIT");
          return { run: mapAutomationRun(current), transitioned: false, reason: "not_retryable" };
        }
      }
      const retryEvent: RunEvidenceEvent = {
        at: new Date().toISOString(), kind: "retry", summary: "A new attempt was requested.", attempt: attempt + 1,
      };
      const updated = await client.query(
        `UPDATE work_items SET status = 'pending', attempt = $3, claimed_by_node_id = NULL,
         claimed_at = NULL, started_at = NULL, completed_at = NULL, lease_expires_at = NULL,
         output = NULL, checks = '[]'::jsonb, receipt_evidence = NULL, events = $4::jsonb
         WHERE account_id = $1 AND id = $2 RETURNING *`,
        [accountId, id, attempt + 1, JSON.stringify([...events, retryEvent].slice(-100))],
      );
      await client.query("COMMIT");
      return { run: mapAutomationRun(updated.rows[0]), transitioned: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionAutomationRun(accountId: string, id: string, status: AutomationRunStatus, output?: AutomationRun["output"], expectedNodeId?: string): Promise<AutomationRun | undefined> {
    const from: Record<AutomationRunStatus, AutomationRunStatus[]> = {
      pending: [],
      claimed: [],
      running: ["claimed"],
      needs_attention: ["running"],
      succeeded: ["running", "needs_attention"],
      // Allow failure straight from "claimed": a node can throw before the
      // best-effort /running transition lands, and the run must still terminate
      // rather than get stuck claimed.
      failed: ["claimed", "running", "needs_attention"],
      cancelled: ["pending", "claimed", "running", "needs_attention"],
    };
    if (from[status].length === 0) return undefined;
    const terminal = ["succeeded", "failed", "cancelled"].includes(status);
    // A lifecycle transition is itself timeline-worthy (issue #153) — record it
    // even when the node never calls the dedicated evidence endpoint, so every
    // run has at least a baseline trigger→claim→attempt→outcome timeline.
    const eventForStatus: Partial<Record<AutomationRunStatus, { kind: RunEvidenceEvent["kind"]; summary: string }>> = {
      running: { kind: "attempt_started", summary: "Execution started on the assigned node." },
      needs_attention: { kind: "needs_attention", summary: "Run needs manual attention." },
      succeeded: { kind: "completed", summary: "Automation run completed successfully." },
      failed: { kind: "completed", summary: "Automation run failed. Detailed diagnostics remain on the node." },
      cancelled: { kind: "cancelled", summary: "Automation run cancelled." },
    };
    const event = eventForStatus[status];
    // No jsonb `||` concatenation here (deliberately): pg-mem — the in-memory
    // Postgres the whole test suite runs against — mis-evaluates the jsonb
    // concatenation operator inside an UPDATE SET (confirmed against real
    // Postgres semantics; see pg-mem issue tracker). A plain read-then-write
    // is a two-query round trip instead of one atomic statement, but this event
    // append is a best-effort timeline entry, not the transition's atomicity
    // guard (the conditional `status = ANY(from[status])` above already is).
    // $8 node guard: when set, the Run must still be claimed by that node, so a
    // Machine that lost its lease to a reclaim (claimed_by_node_id now points at
    // the new owner) no-ops here instead of overwriting the fresh attempt.
    const { rows } = await this.query(
      `UPDATE work_items SET status = $3,
       started_at = CASE WHEN $3 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
       completed_at = CASE WHEN $4 THEN COALESCE(completed_at, now()) ELSE completed_at END,
       lease_expires_at = CASE
         WHEN $4 OR $3 = 'needs_attention' THEN NULL
         WHEN $3 = 'running' THEN $7
         ELSE lease_expires_at END,
       output = COALESCE($5, output)
       WHERE account_id = $1 AND id = $2 AND status = ANY($6)
         AND ($8::text IS NULL OR claimed_by_node_id = $8) RETURNING *`,
      [accountId, id, status, terminal, output ? JSON.stringify(output) : null, from[status], workLeaseExpiry(), expectedNodeId ?? null],
    );
    if (!rows[0]) return undefined;
    if (!event) return mapAutomationRun(rows[0]);
    const events = [...(rows[0].events ?? []), { at: new Date().toISOString(), ...event }].slice(-100);
    const { rows: withEvent } = await this.query(
      `UPDATE work_items SET events = $3::jsonb WHERE account_id = $1 AND id = $2 RETURNING *`,
      [accountId, id, JSON.stringify(events)],
    );
    return mapAutomationRun(withEvent[0] ?? rows[0]);
  }

  /** Issue #153 — record a sanitized, node-reported evidence patch against a
   *  run it claimed. `checks`/`events` are appended to existing history;
   *  `routingReason`/`output` fields are merged, last-write-wins per field.
   *  Read-then-write (not an atomic jsonb `||` UPDATE) — see the comment in
   *  transitionAutomationRun for why; a lost update here just drops one
   *  low-frequency evidence report, never the run's actual status. */
  async appendRunEvidence(accountId: string, id: string, patch: RunEvidencePatch): Promise<AutomationRun | undefined> {
    const { rows } = await this.query(`SELECT * FROM work_items WHERE account_id = $1 AND id = $2`, [accountId, id]);
    if (!rows[0]) return undefined;
    const current = rows[0];
    const routingReason = patch.routingReason ?? current.routing_reason ?? undefined;
    const output = patch.output ? { ...(current.output ?? {}), ...patch.output } : (current.output ?? {});
    const checks = patch.checks ? [...(current.checks ?? []), ...patch.checks].slice(-50) : (current.checks ?? []);
    const events = patch.events ? [...(current.events ?? []), ...patch.events].slice(-100) : (current.events ?? []);
    const receiptEvidence = patch.receiptEvidence ?? current.receipt_evidence ?? null;
    const { rows: updated } = await this.query(
      `UPDATE work_items SET routing_reason = $3, output = $4::jsonb, checks = $5::jsonb, events = $6::jsonb, receipt_evidence = $7::jsonb
       WHERE account_id = $1 AND id = $2 RETURNING *`,
      [accountId, id, routingReason ?? null, JSON.stringify(output), JSON.stringify(checks), JSON.stringify(events), JSON.stringify(receiptEvidence)],
    );
    return updated[0] ? mapAutomationRun(updated[0]) : undefined;
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
       WHERE account_id = $1 AND label = ANY($2)
         AND (status = 'pending' OR (status IN ('claimed', 'running') AND lease_expires_at < now()))
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
    // Conditional UPDATE makes both first claim and stale-lease reclaim atomic.
    // A crashed node cannot strand work forever; a live node renews below.
    const { rows } = await this.query(
      `UPDATE work_items
       SET status = 'claimed', claimed_by_node_id = $3, claimed_at = now(),
           lease_expires_at = $4,
           attempt = CASE WHEN status = 'pending' THEN COALESCE(attempt, 1) ELSE COALESCE(attempt, 1) + 1 END
       WHERE id = $2 AND account_id = $1
         AND (status = 'pending' OR (status IN ('claimed', 'running') AND lease_expires_at < now()))
       RETURNING *`,
      [accountId, id, nodeId, workLeaseExpiry()],
    );
    if (!rows[0]) return undefined;
    // Best-effort timeline entry (issue #153) — read-then-write, same rationale
    // as transitionAutomationRun; the claim's atomicity is already guaranteed
    // above and does not depend on this second query.
    const claimedEvent: RunEvidenceEvent = { at: new Date().toISOString(), kind: "claimed", summary: "Run claimed by an eligible node.", ref: nodeId };
    const events = [...(rows[0].events ?? []), claimedEvent].slice(-100);
    const { rows: withEvent } = await this.query(
      `UPDATE work_items SET events = $3::jsonb WHERE account_id = $1 AND id = $2 RETURNING *`,
      [accountId, id, JSON.stringify(events)],
    );
    return mapWorkItem(withEvent[0] ?? rows[0]);
  }

  async renewWorkItemLease(accountId: string, nodeId: string, id: string): Promise<WorkItem | undefined> {
    const { rows } = await this.query(
      `UPDATE work_items
       SET lease_expires_at = $4
       WHERE account_id = $1 AND id = $2 AND claimed_by_node_id = $3
         AND status IN ('claimed', 'running')
       RETURNING *`,
      [accountId, id, nodeId, workLeaseExpiry()],
    );
    return rows[0] ? mapWorkItem(rows[0]) : undefined;
  }

  async recordRunStart(accountId: string, runKey: string): Promise<boolean> {
    // Idempotent: PRIMARY KEY(account_id, run_key) + DO NOTHING means recording the
    // same run twice (reconnects, repeated advertises) leaves the original
    // started_at intact and never inflates the daily count.
    const existing = await this.query(
      `SELECT 1 FROM run_starts WHERE account_id = $1 AND run_key = $2`,
      [accountId, runKey],
    );
    const { rows } = await this.query(
      `INSERT INTO run_starts (account_id, run_key) VALUES ($1, $2)
       ON CONFLICT (account_id, run_key) DO NOTHING
       RETURNING run_key`,
      [accountId, runKey],
    );
    return existing.rows.length === 0 && rows.length > 0;
  }

  async countRunStartsSince(accountId: string, sinceIso: string, runKeyPrefix?: string): Promise<number> {
    // One distinct run_key = one run. A prefix scopes commercial metering to a
    // class of work without losing the all-source product funnel in this table.
    // Prefixes are internal class constants (`automation:`), never user input.
    const prefixClause = runKeyPrefix === undefined ? "" : " AND run_key LIKE $3";
    const { rows } = await this.query(
      `SELECT count(*)::int AS n FROM run_starts
       WHERE account_id = $1 AND started_at >= $2${prefixClause}`,
      runKeyPrefix === undefined ? [accountId, sinceIso] : [accountId, sinceIso, `${runKeyPrefix}%`],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async pruneRunStartsBefore(beforeIso: string): Promise<number> {
    // Rows older than the rolling window can never be counted again, so drop them.
    const { rowCount } = await this.query(
      `DELETE FROM run_starts WHERE started_at < $1`,
      [beforeIso],
    );
    return rowCount ?? 0;
  }

  async countTrialSessions(accountId: string): Promise<number> {
    const { rows } = await this.query(
      `SELECT count(*)::int AS n FROM trial_sessions WHERE account_id = $1`,
      [accountId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async overTrialSessionIds(accountId: string, limit: number): Promise<Set<string>> {
    // Everything beyond the first `limit` sessions by first-seen order is outside
    // the trial. OFFSET past the allowance returns exactly those rows, so the earliest
    // `limit` sessions stay visible (a running session is never yanked when the wall
    // is hit) and only newer ones are withheld. Ordered by (first_seen, session_id)
    // for a stable tiebreak when timestamps collide.
    if (!Number.isFinite(limit) || limit < 0) return new Set();
    const { rows } = await this.query(
      `SELECT session_id FROM trial_sessions
       WHERE account_id = $1
       ORDER BY first_seen ASC, session_id ASC
       OFFSET $2`,
      [accountId, limit],
    );
    return new Set(rows.map((r: { session_id: string }) => r.session_id));
  }

  async pruneExpiredAuthTokens(nowIso: string): Promise<number> {
    // Each of these tables is otherwise only deleted on successful single-use
    // consumption (see consumeLoginToken, consumeRelayTicket, etc.) — an
    // abandoned attempt just leaves an expired row sitting there forever.
    // Sequential DELETEs on indexed expires_at columns; cheap even at scale, and
    // there is no cross-table transaction requirement (each row is independently
    // safe to drop once past its own expiry).
    let total = 0;
    for (const table of ["login_tokens", "sessions", "link_grants", "relay_tickets", "device_logins", "oauth_states"]) {
      const { rowCount } = await this.query(`DELETE FROM ${table} WHERE expires_at < $1`, [nowIso]);
      total += rowCount ?? 0;
    }
    const { rowCount } = await this.query(`DELETE FROM auth_rate_limits WHERE reset_at < $1`, [nowIso]);
    total += rowCount ?? 0;
    return total;
  }

  async completeWorkItem(accountId: string, id: string, expectedNodeId?: string): Promise<AutomationRun | undefined> {
    // Older nodes only know claim → complete. Adapt that boundary onto the
    // canonical lifecycle without preserving a second legacy transition path.
    // The node guard flows into both hops so a reclaimed-away Machine cannot
    // complete the new attempt (returns undefined, and the caller reports a
    // conflict rather than a spurious success).
    const current = await this.getAutomationRun(accountId, id);
    if (current?.status === "claimed") await this.transitionAutomationRun(accountId, id, "running", undefined, expectedNodeId);
    return (await this.transitionAutomationRun(accountId, id, "succeeded", undefined, expectedNodeId)) ?? undefined;
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
    triggerAccess: row.trigger_access === "contributor" || row.trigger_access === "collaborator" ? row.trigger_access : undefined,
    servingNodeId: row.serving_node_id ?? undefined,
    servingNodeSeenAt: row.serving_node_seen_at ? new Date(row.serving_node_seen_at).toISOString() : undefined,
    enabled: row.enabled ?? true,
    templateInstruction: row.template_instruction ?? undefined,
    routingDefault: row.routing_default ?? undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

/** Shared evidence-field projection (issue #153) for both mapWorkItem and
 *  mapAutomationRun. Defensively re-bounds on read (in addition to the bounds
 *  already enforced at write time by run-evidence.ts) so a row written by an
 *  older/looser server version can never balloon a response unbounded. */
function mapEvidenceFields(row: any): { routingReason?: string; checks: RunCheck[]; events: RunEvidenceEvent[]; receiptEvidence?: AutomationRun["receiptEvidence"] } {
  return {
    routingReason: row.routing_reason ?? undefined,
    checks: Array.isArray(row.checks) ? row.checks.slice(-50) : [],
    events: Array.isArray(row.events) ? row.events.slice(-100) : [],
    receiptEvidence: row.receipt_evidence && typeof row.receipt_evidence === "object" ? row.receipt_evidence : undefined,
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
    eventContext: row.event_context ?? undefined,
    repo: row.repo ?? undefined,
    issueNumber: row.issue_number ?? undefined,
    externalId: row.external_id ?? undefined,
    url: row.url ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    claimedByNodeId: row.claimed_by_node_id ?? undefined,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : undefined,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    collapseKey: row.collapse_key ?? undefined,
    defaultRouted: row.default_routed ?? undefined,
    runtimeId: row.runtime_id ?? undefined,
    model: row.model ?? undefined,
    installationId: row.installation_id ?? undefined,
    appId: row.app_id ?? undefined,
    ephemeral: row.ephemeral ?? undefined,
    approvalMode: row.approval_mode ?? undefined,
    sandbox: row.sandbox ?? undefined,
    maxAttempts: row.max_attempts == null ? undefined : Number(row.max_attempts),
    definitionId: row.definition_id ?? undefined,
    triggerId: row.trigger_id ?? undefined,
    triggerKind: row.trigger_kind ?? undefined,
    attempt: Number(row.attempt ?? 1),
    targetKind: row.target_kind ?? "new_session",
    targetSessionId: row.target_session_id ?? undefined,
    message: Boolean(row.message) || undefined,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : undefined,
    output: row.output ?? undefined,
    ...mapEvidenceFields(row),
  };
}

function triggerKindForSource(explicit: AutomationTriggerKind | undefined, source: string): AutomationTriggerKind {
  if (explicit) return explicit;
  if (source.startsWith("github:")) return "github";
  if (source.startsWith("linear:")) return "webhook";
  if (source === "slack") return "slack";
  if (source === "manual") return "manual";
  return "webhook";
}

function mapStringList(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function mapAutomationDefinition(row: any): AutomationDefinition {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    configKey: row.config_key ?? undefined,
    configOrder: row.config_order == null ? undefined : Number(row.config_order),
    templateCiphertext: row.template_ciphertext ?? undefined,
    runtimeId: row.runtime_id ?? undefined,
    model: row.model ?? undefined,
    nodeLabel: row.node_label ?? undefined,
    ephemeral: row.ephemeral ?? undefined,
    approvalMode: row.approval_mode ?? undefined,
    sandbox: row.sandbox ?? undefined,
    maxAttempts: row.max_attempts == null ? undefined : Number(row.max_attempts),
    enabled: Boolean(row.enabled),
    trigger: row.trigger ?? undefined,
    webhookSecret: row.webhook_secret ?? undefined,
    repo: row.repo ?? undefined,
    labels: mapStringList(row.labels),
    repos: mapStringList(row.repos),
    on: mapEventRules(row.on_events),
    templateId: row.template_id ?? undefined,
    target: row.target_kind === "existing_session" && row.target_session_id
      ? { kind: "existing_session", sessionId: row.target_session_id }
      : undefined,
    message: Boolean(row.message) || undefined,
    schedule: row.schedule,
    nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : undefined,
    lastScheduledAt: row.last_scheduled_at ? new Date(row.last_scheduled_at).toISOString() : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapEventRules(value: unknown): AutomationDefinition["on"] | undefined {
  if (value == null) return undefined;
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return undefined; }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  return parsed as AutomationDefinition["on"];
}

function mapTriggerEvent(row: any): TriggerEvent {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    sourceKey: row.source_key ?? undefined,
    sourceRef: row.source_ref ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapAutomationRun(row: any): AutomationRun {
  const sourceRef = {
    ...(row.repo ? { repo: row.repo } : {}),
    ...(row.issue_number !== null && row.issue_number !== undefined ? { issueNumber: row.issue_number } : {}),
    ...(row.url ? { url: row.url } : {}),
  };
  return {
    id: row.id,
    accountId: row.account_id,
    definitionId: row.definition_id ?? undefined,
    triggerId: row.trigger_id ?? `legacy:${row.id}`,
    triggerKind: triggerKindForSource(row.trigger_kind ?? undefined, row.source),
    status: row.status === "done" ? "succeeded" : row.status,
    attempt: Number(row.attempt ?? 1),
    maxAttempts: row.max_attempts == null ? undefined : Number(row.max_attempts),
    target: row.target_kind === "existing_session"
      ? { kind: "existing_session", sessionId: row.target_session_id }
      : { kind: "new_session" },
    routing: {
      nodeLabel: row.label,
      runtimeId: row.runtime_id ?? undefined,
      model: row.model ?? undefined,
      ephemeral: row.ephemeral ?? undefined,
      approvalMode: row.approval_mode ?? undefined,
      sandbox: row.sandbox ?? undefined,
    },
    output: row.output ?? undefined,
    title: row.title,
    body: row.body ?? undefined,
    message: Boolean(row.message) || undefined,
    eventContext: row.event_context ?? undefined,
    source: row.source,
    sourceRef: Object.keys(sourceRef).length ? sourceRef : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    claimedByNodeId: row.claimed_by_node_id ?? undefined,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : undefined,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : undefined,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
    ...mapEvidenceFields(row),
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
    bootstrapStatus: row.bootstrap_status ?? undefined,
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
