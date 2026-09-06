# Remote session admission

Core has no plan names or session allowances. Operators may configure
`DEPLOYMENT_EXTENSION_URL` and `DEPLOYMENT_EXTENSION_TOKEN` to authorize remote
session creation. Without an extension, self-hosted Core is unrestricted.

The node scopes encrypted relay commands and control-plane automation execution
through `src/session/remote-session-admission.ts`. The common `createSession`
boundary authorizes `session.create` through authenticated `/node/policy/check`
before allocating a new session. GitHub, Linear, schedules, Slack, generic
webhooks, delegated work, manual sessions, and forks use this same boundary.

- Actual new sessions consume admission, not automation enqueue/claim or relay
  connections. `automation.run` remains a separate non-creation policy hook.
- Local/direct commands, history publication, resumed sessions, follow-up turns,
  and internal model-catalog probes do not request new-session admission.
- A follow-up which falls back to creating a new session does request admission.
- A fork opens a newly materialized transcript: it is marked `newSession`, not
  mistaken for a resume merely because it has a session-file reference.
- Remote request identity and per-request creation ordinal form stable keys.
  Multiple creations get separate keys; retries use the same keys. Automation
  keys use the durable Run ID, independent of lease delivery or worker node.
- A denied automation parks in `needs_attention` with `policy_denial` evidence.
  It does not invoke agent-provider retry/reroute policies. Resumes remain usable.
- A configured extension's transport/malformed-response failure denies new
  creation. The node request has a bounded timeout.

Admission reserves allowance before creation; a downstream launch failure can
retry with the same identity without reserving a second slot. Durable quota
storage and its window/idempotency semantics belong to the operator extension.

## Rollout

Upgrade connected node daemons as well as the control plane before relying on
unified admission. Older nodes meter only manual `session.new`; deploying a new
control plane cannot retrofit the encrypted node-side creation boundary.

Ephemeral launch UI is hidden by default. Operators choosing to enable it build
with `VITE_EPHEMERAL_MACHINES_ENABLED=1`; deployments can independently deny
provisioning and set `EPHEMERAL_MACHINES_ENABLED=0`. This does not remove cleanup
or the underlying self-hostable provisioning implementation.
