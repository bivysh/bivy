# Pitch-gap + moat roadmap (synthesized)

**Started:** 2026-08-12
**Status:** Active
**Positioning:** [`docs/why-bivy.md`](../why-bivy.md)
**Decision record:** [`product-roadmap-decisions.md`](product-roadmap-decisions.md) — D-016 (govern the substrate), D-017 (this synthesis)
**Companion:** [`platform-modularization-plan.md`](platform-modularization-plan.md) (the refactor spine)

## Synthesis (two explorations reconciled)

Two parallel explorations converged. A **product/pitch** track audited the code
and found the pitch **~90% shipped** (automations, BYO-cloud ephemeral, credential
sync, multi-agent runtime, full self-host are real and tested), with the value
led by *reach + privacy + no-lock-in*. A **moat/competitive** track found that
**remote-reach is commoditizing** (native Claude Code Remote Control, self-hostable
E2E relays, opencode's client/server at scale), so reach is **table stakes**; the
**durable moat is the agent-agnostic *governed* substrate + sovereignty economics**
(D-016).

**Reconciled strategy:** the product largely exists — so the work is **close the
integrity gap, productize, and (re)position on the durable moat**, not a greenfield
build. Three pillars (see why-bivy.md): (1) sovereign & no-lock-in, (2) **governed
& provable** (audit promoted from an automation footnote to a headline pillar),
(3) reachable & unattended (reach as table stakes done frictionlessly).

## Reprioritized roadmap

Ordered by *(mostly-shipped → just promote/productize)* × *(serves the moat)*.
Each step is its own CI-gated PR against `main`; auth-fragile ones need a live
node+phone (or 2-node) smoke.

### 1. Account-free remote pairing — PRIMARY (closes the one integrity gap)
The pitch says "add remote — still no account," but `relay-setup.ts` always
enrolls in the control plane. The account-free primitive already exists and is
unused as a default (`pair.hello`/`pairingProof` → `PairingStore.trustDevice`,
`NodeIdentity`). This is *promotion + one severed cord*, and it doubles as the
**reference consumer for `@bivy/remote` (modularization Phase 3): it proves the
relay ports don't need the control plane.**
- **1.1** Relay: no-control-plane admission mode (room-token path alongside the
  CP-ticket path; per-room capability token + IP rate-limit for a public blind
  relay). *Live smoke.*
- **1.2** Node: `--solo` setup path (local `NodeIdentity`, mint a room token,
  write `relay.json` with `room`+`mode:"solo"` and no enrollment token, print a QR;
  skip device-login + `/nodes/enroll`).
- **1.3** Node relay-client: dial with the room token; pairing flows through the
  existing `pair.hello` → `trustDevice` branch.
- **1.4** PWA: account-free pairing entry (configure transport from the QR payload;
  run `pair.hello`; persist client-side; no sign-in screen; multi-node = scan more).
- **1.5** App origin: confirm the PWA is served from a CP-independent blind origin /
  installed PWA / tailnet HTTPS (likely no code).
- **1.6** Reconcile pitch + `bivy setup` copy so "remote, no account" is literally
  true.

### 2. Governed & provable — the audit trail (the durable moat)
Promote audit from "automations are accountable" to a first-class, cross-agent
governance surface. (Slice 1 shipped: guardian tool-call decisions → `bivy audit`.)
- **2.2** Fold in network attempts (egress decider) + approval decisions.
- **2.3** Fold in file-change + cost events.
- **Deferred (team feature):** control-plane aggregation → cross-node org view.
- Redaction contract throughout: decisions + metadata, never payloads.

### 3. One-click BYO-cloud automations (ungate the shipped engine)
Provisioning works (`ephemeral.ts` / `ephemeral-provisioner.ts`) but is off behind
a global `EPHEMERAL_MACHINES_ENABLED` flag.
- **3.1** Gate on per-account "validated provider token + opted in" instead of the
  global env flag (fail-closed by default).
- **3.2** Provider-key onboarding (`bivy` cmd + PWA): add + live-validate a Hetzner/
  Fly/AWS token, store account-scoped.
- **3.3** Automation → ephemeral UX: when an automation fires with no node online,
  offer "run it on your cloud"; surface teardown + the audit trail.

### 4. Credential/policy broker polish
Make the shipped credential service (`src/credentials/`) a first-class cross-agent
surface: broaden past model keys, scoped leases (not an env dump), reference-first
UX (secret stays in your vault), and credential-use audit (feeds #2).

### Deferred / optional
- Remote runtime host (`BIVY_REMOTE_RUNTIME`, agent/node decoupling) — in-process
  multi-agent already ships; track under `platform-modularization-plan.md` Phase 3.
- Multi-client contract versioning (Phase 2 slices 2b/3), remaining `@bivy/remote`
  slices, `@bivy/credentials` package promotion — only if a concrete ask revives
  them.

## Sequencing
Gap 1 (1.1→1.4 sequential) first; audit (#2) continues in parallel (different
subsystem); BYO-cloud (#3) and broker (#4) follow. Fold Gap-1 progress into
`platform-modularization-plan.md` (it is Phase 3's reference consumer).
