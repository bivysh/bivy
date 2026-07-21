# Control Plane (skeleton)

Hosted service for accounts, node registry, entitlements, and billing. This is
the **control plane**. The **data plane** (node daemon) lives in the repo root
and never sends session content here.

See `../../CLOUD.md` for the open-core boundary and what the control plane does.

## Run

```bash
cd services/control-plane
npm install
npm run dev   # http://localhost:4400
```

## Current status

Runnable skeleton with **in-memory dev storage** or **Postgres when
`DATABASE_URL` is set**, plus **stubbed auth/billing**. Implements the core
shapes so the relay (Step 2) and node enrollment can be built against real
endpoints.

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/magic-link/start` | none | Send passwordless login email. Uses Resend when `RESEND_API_KEY` is set; dev-link fallback outside production. |
| POST | `/auth/magic-link/consume` | none | Consume login token → user session token. |
| GET | `/auth/magic-link/consume?token=…` | none | Browser login link; redirects to remote client with session payload. |
| POST | `/auth/dev-login` | none | DEV/staging login by email. Disable for live beta with `DISABLE_DEV_LOGIN=1`. |
| GET | `/me` | user | Account + entitlements. |
| POST | `/nodes/enroll` | user | Enroll a node by its `nodeId`; returns one-time enrollment token. Enforces `maxNodes`. |
| GET | `/nodes` | user | List the account's nodes. |
| DELETE | `/nodes/:id` | user | Revoke a node. |
| POST | `/node/heartbeat` | node | Mark node online. |
| GET | `/node/entitlements` | node | Owner's entitlements (node self-gating, Step 6). |
| POST | `/billing/checkout` | user | Creates Stripe Checkout when Stripe env is configured; dev placeholder outside production. |
| POST | `/billing/webhook` | Stripe signature | Verifies signed Stripe webhook and maps subscription events to plan. |

Two token types: **user session tokens** (`sess_…`) and **node enrollment
tokens** (`enr_…`). Both sent as `Authorization: Bearer …`.

### Plans / entitlements

Defined in `src/store.ts` (`PLAN_ENTITLEMENTS`):

- `free`: 1 node, 2 devices, no push, no hosted relay
- `individual`: 5 nodes, 10 devices, push, relay
- `team`: 50 nodes, 200 devices, push, relay

## TODO before production (do not deploy the skeleton)

1. **Auth**: finish production auth UX around magic links/OAuth, configure
   `RESEND_API_KEY`, and disable `/auth/dev-login` for live beta.
2. **Billing**: configure Stripe products/prices/webhook in test mode,
   verify end-to-end, add billing portal, and store full subscription status.
3. **Node enrollment UX**: pair the node-side enrollment flow (the node posts
   its `nodeId`, stores the returned `enr_` token in `.bivy/`).
4. **Never** accept or store session content, files, prompts, or credentials.

## How the node connects (next: Step 2 relay)

1. User signs in (control plane) → `/nodes/enroll` with the node's `nodeId`.
2. Node stores the `enr_` token locally (in `.bivy/`).
3. Node dials the relay outbound, authenticating with the `enr_` token.
4. Clients reach the node through the relay. Relay routes opaque, E2E-encrypted
   frames and cannot read session content.
