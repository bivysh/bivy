# Control Plane

Self-hostable service for accounts, node registry, vaults, session index, and
GitHub/automation coordination. The **data plane** (node daemon) lives in the
repo root and never sends interactive session content here.

Commercial billing, plans, metering, and admission policy are not part of this
service. Bivy Cloud owns those concerns in the separate Cloud repository.

## Run

```bash
cd services/control-plane
npm install
npm run dev   # http://localhost:4400
```

## Storage

Uses an in-memory Postgres-compatible store by default, or Postgres when
`DATABASE_URL` is set. The control plane auto-creates its tables on startup.

## Core endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/magic-link/start` | none | Send passwordless login email. |
| POST | `/auth/magic-link/consume` | none | Consume login token and create a user session. |
| POST | `/auth/dev-login` | none | Development login; disabled in production. |
| GET | `/me` | user | Account identity and usage counts. |
| POST | `/nodes/enroll` | user | Enroll a node and return an enrollment token. |
| GET | `/nodes` | user/node | List account nodes. |
| DELETE | `/nodes/:id` | user | Revoke a node. |
| POST | `/node/heartbeat` | node | Mark a node online. |

Core does not apply commercial feature or usage limits.

## How the node connects

1. A user signs in and enrolls a node.
2. The node stores its `enr_…` token locally.
3. The node mints a single-use relay ticket and dials the relay outbound.
4. Clients reach the node through the relay; session frames remain E2E encrypted.
