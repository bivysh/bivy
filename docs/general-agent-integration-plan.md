# General agent integration hardening plan

## Goal

Make Bivy's generic process and ACP paths preserve conversation identity, report governance honestly, and enforce the selected workspace boundary without adding agent-specific adapters.

## Work plan

### 1. Process session identity

- Add a parser-level native session reference signal.
- Capture native refs from validated structured formats that expose them.
- Persist the captured ref on a fresh `ProcessSession` and use the generic resume template on subsequent turns.
- Add a host-assigned session-ref recipe for agents that accept an id at creation time.
- Keep resume disabled when neither strategy can establish a native ref.
- Test a fresh two-turn process session, persistence, and reopen.

### 2. ACP governance semantics

- Emit `tool.call` only for ACP permission requests that are blocked awaiting a decision.
- Emit `tool.observe` for activity notifications that may already be executing.
- Ensure observed activity never opens an approval prompt.
- Keep permission decisions fail-closed and test allow and deny paths.

### 3. ACP filesystem boundary

- Pass the selected sandbox tier to the ACP bridge.
- Confine ACP filesystem client operations to the session workspace, including symlink-safe checks.
- Reject ACP writes in read-only mode.
- Route writable filesystem requests through the existing protocol approval decision path before execution.
- Add traversal, symlink, read-only, allow, and deny tests.

### 4. Honest ACP continuity and inputs

- Stop silently replacing a failed `session/load` with a new empty session.
- Return an actionable resume failure so callers can use the existing disclosed seeded-continuation path.
- Forward image prompt blocks to ACP agents.
- Thread Bivy MCP configuration through the production runtime factory rather than relying on ambient test environment variables.
- Add end-to-end tests through `makeRuntime()`.

### 5. Declarative integration model

- Introduce reusable session-reference and adapter-selection data primitives without creating another registry.
- Prevent legacy custom profiles from inheriting agent-specific host behaviors accidentally.
- Extend the plugin manifest with backward-compatible general fields where required by the work above.
- Keep third-party code out of the daemon.

### 6. Validation and documentation

- Add conformance coverage for two-turn continuity, ACP observed versus gated tools, filesystem confinement, failed resume, images, and MCP forwarding.
- Update capability descriptions and support documentation to match actual adapter behavior.
- Run typecheck, lint, unit tests, boundaries, routes, and design checks.

## Implementation status

- [x] Process sessions preserve captured or host-assigned native references across turns.
- [x] ACP distinguishes observed activity from permission-gated calls.
- [x] ACP filesystem access is workspace-confined, symlink-safe, sandbox-aware, and approval-gated for writes.
- [x] ACP resume failures are explicit; images and production-factory MCP configuration are forwarded.
- [x] Plugin manifests support host-assigned session references; custom commands no longer inherit maintained host behavior.
- [x] Capability documentation and conformance coverage match the implemented paths.
- [x] Typecheck, web typecheck, lint, unit/core tests, boundaries, routes, design, and link checks pass.

## Delivery

Commits are split by independently reviewable behavior. The PR is ready once the final validation commit is pushed.
