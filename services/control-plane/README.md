# Control Plane

Hosted service for accounts, node registry, vaults, session index, GitHub App
connections, entitlements, and billing. This is the **control plane**. The
**data plane** (node daemon) lives in the repo root and never sends session
content here.

See `../../CLOUD.md` for the open-core boundary and what the control plane does.

## Run

```bash
cd services/control-plane
npm install
npm run dev   # http://localhost:4400
```

## Storage

Uses **in-memory dev storage** by default, or **Postgres when `DATABASE_URL` is
set**. The control plane auto-creates its tables on startup.

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/magic-link/start` | none | Send passwordless login email. Uses Resend when `RESEND_API_KEY` is set; dev-link fallback outside production. |
| POST | `/auth/magic-link/consume` | none | Consume login token → user session token. |
| GET | `/auth/magic-link/consume?token=…` | none | Browser login link; redirects to remote client with session payload. |
| POST | `/auth/dev-login` | none | DEV/staging login by email. Disable for live beta with `DISABLE_DEV_LOGIN=1`. |
| GET | `/me` | user | Account + entitlements. |
| POST | `/nodes/enroll` | user | Enroll a node by its `nodeId`; returns one-time enrollment token. |
| GET | `/nodes` | user | List the account's nodes. |
| DELETE | `/nodes/:id` | user | Revoke a node. |
| POST | `/node/heartbeat` | node | Mark node online. |
| GET | `/node/entitlements` | node | Owner's entitlements (for node self-gating). |
| POST | `/billing/checkout` | user | Creates Stripe Checkout when Stripe env is configured; dev placeholder outside production. |
| POST | `/billing/webhook` | Stripe signature | Verifies signed Stripe webhook and maps subscription events to plan. |

Two token types: **user session tokens** (`sess_…`) and **node enrollment
tokens** (`enr_…`). Both sent as `Authorization: Bearer …`.

### Plans / entitlements

Defined in `src/store.ts` (`PLAN_ENTITLEMENTS`):

- `free`: unlimited nodes and devices, push, hosted relay, work queue, and
  ephemeral runners — capped only at 10 runs per rolling 7-day window.
- `pro`: same features, no run cap.
- `team`: same features, no run cap.

Entitlements are only enforced when `ENFORCE_ENTITLEMENTS=1` (Bivy Cloud);
self-hosted stacks leave it off, so every feature is on for every account.

## How the node connects

1. User signs in (control plane) → `/nodes/enroll` with the node's `nodeId`.
2. Node stores the `enr_` token locally (in `.bivy/`).
3. Node dials the relay outbound, authenticating with the `enr_` token.
4. Clients reach the node through the relay. Relay routes opaque, E2E-encrypted
   frames and cannot read session content.
