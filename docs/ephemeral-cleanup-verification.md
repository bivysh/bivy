# Canceled launch cleanup and retired session deletion

## Two independent failures

Canceled attempts without a recorded machine ID bypassed machine reconciliation.
Retry exhaustion unenrolled the node but left the attempt nonterminal, so account
capacity stayed reserved indefinitely. A missing machine receipt is not proof of
provider absence: a create response may have been lost, or an empty app may remain.

Retired sessions were reconstructed from account session correlations. The old
Delete action sent a command to a node that was already gone; deleting a local row
alone could not remove the durable account history.

## Fix

- Reconcile canceled, unmaterialized attempts under the account provisioning lease.
  Only finalize after provider-confirmed absence and a fresh receipt-version check.
  Cleanup retains operator credential access when new launches are disabled.
- Fly inventories the exact generated dedicated app, refuses foreign or ambiguous
  machine ownership, removes owned resources, and requires a final app GET 404.
  Provider failures and unsupported adapters retain reservations. Cleanup requests
  have bounded HTTP timeouts. Capacity accounting is not weakened.
- Account-authenticated `DELETE /session-correlation/:sessionId` deletes retained
  correlation, encrypted snapshot and index visibility without contacting a node.
  Online nodes still require the normal live-session deletion path.
- A durable account/session tombstone fences late snapshot and correlation writes
  under the same account lock. Late node advertisements remain hidden. Deletion
  is idempotent and cannot affect another account's same-named session.
- Saved sidebar rows offer Delete directly, without opening/rebuilding the machine.
  The existing confirmation dialog protects deletion. Failed requests retain the
  row; pending deletion disables its button. Successful deletion persists the local
  tombstone. Row sizing prevents Retry/Dismiss clipping and uses existing spacing
  tokens for touch targets.

## Live recovery — staging, 2026-09-15

Three previously canceled managed attempts had exhausted eight retries and were
still reserving account capacity. Read-only Fly inspection found one app absent
and two legacy apps present with zero machines.

With the account provisioning lease held, the two empty apps were removed. All
three apps were confirmed absent before one transaction terminalized the three
original attempt versions. The transaction required unchanged failed/delete-intent
state, no machine receipt, and the still-owned lease; it would roll back on any
mismatch. A subsequent independent read confirmed:

- All three app GETs and machine inventories: HTTP 404.
- All three original attempts: `state=deleted`, `observed_state=gone`.

This recovery released three existing reservations. It did not start machines,
raise account limits, change billing settings, or delete user session history.
It was a narrowly scoped operator recovery, **not** a deployment or live validation
of the new reconciler, schema migration, or sidebar action.

## Automated evidence

- 703 core tests / 60 files, including Fly ownership and absence confirmation.
- 52 control-plane suites, including lease/version fencing, provider uncertainty,
  cleanup while disabled, transactional deletion and late-write rejection.
- Real HTTP authentication, account isolation, online-node guard and idempotency
  tests against the in-memory PostgreSQL-compatible test service.
- Four browser cases exercise the real sidebar/controller at desktop/mobile widths
  in light/dark themes: keyboard confirmation, cancel, failure/retry, no node
  command or rebuild, successful deletion, and un-clipped actions. Rendered
  screenshots were reviewed; touch-target sizing was refined and retested.

No new real-provider launch or guest-hardening certification is claimed.
