# Product roadmap decision record — Phases 0–2

This is the review trail for material decisions made while implementing [`product-roadmap-implementation-plan.md`](product-roadmap-implementation-plan.md). Append entries; do not rewrite historical decisions silently.

## D-001 — Use the existing runtime catalog as the product capability source

**Date:** 2026-08-03
**Status:** Accepted

The runtime definitions in `src/runtime/index.ts`, the generated CLI agent manifest, and runtime capability events already represent most of the required model. We will extend this path rather than add a product-only registry. UI labels, docs, diagnostics, and certification metadata should derive from the same definitions.

**Reason:** A parallel registry would recreate the drift the roadmap is intended to remove.

## D-002 — Protection is a factual summary, not a “safe/unsafe” score

**Date:** 2026-08-03
**Status:** Accepted

Customer-facing protection will distinguish native isolation, Bivy structured tool controls, effect/MCP-level controls, external isolation, and execution as the user's account. The shell guard remains accident prevention and will not be marketed as adversarial isolation.

**Reason:** The mechanisms have different security properties that cannot honestly be collapsed into one badge.

## D-003 — Remote enrollment stays required in setup

**Date:** 2026-08-03
**Status:** Accepted

`bivy setup` offers only Bivy Cloud remote and self-hosted remote paths, and requires relay/control-plane enrollment. An account-free "Local CLI only" setup mode is explicitly out of scope.

**Reason:** Remotely visible, steerable sessions are Bivy's core value; without a relay/control plane the product adds little over running the agent directly. A local-only setup path was tried and rejected as the wrong product direction.

## D-004 — A turn watchdog is enabled by default and configurable

**Date:** 2026-08-03
**Status:** Accepted

Interactive turns receive a finite default watchdog, configurable through `BIVY_TURN_TIMEOUT_MS`; explicit `0` disables it for trusted specialist use. Automation may set a stricter bounded timeout. Timeout aborts the runtime, clears working state, emits an explicit outcome, and releases teardown/queue progress.

**Reason:** A default-off watchdog does not solve stuck sessions or paid-runner leaks. A configurable escape hatch preserves unusual long-running workflows.

## D-005 — Event-log failures degrade the session loudly, not the daemon catastrophically

**Date:** 2026-08-03
**Status:** Accepted

Missing logs remain a normal empty state. Permission, I/O, and corruption failures are recorded and surfaced through diagnostics/session notices. Pending writes remain queued for retry. Timer-driven flush failures do not throw uncaught exceptions that terminate the node.

**Reason:** Silent loss is unacceptable, but crashing the process can compound data loss and interrupt unrelated sessions.

## D-006 — Automatic provisioning is policy-driven, never render-driven

**Date:** 2026-08-03
**Status:** Accepted

A user may explicitly enable an automatic queue fallback with visible provider/rate/TTL/teardown semantics. Once enabled, provisioning belongs in the control-plane/queue policy path and must work without a Settings or queue panel being open. Rendering a component is never the causal trigger for spend.

**Reason:** Automation should be dependable and explicit; tying it to UI mount is both surprising and operationally incomplete.

## D-007 — Build Phase 2 on existing evidence/checkpoint primitives

**Date:** 2026-08-03
**Status:** Accepted

The existing `GithubQueueItem` evidence, checks, events, checkpoint diff, PR detection, and Inbox are the foundation for the unified outcome model. We will normalize and enrich them instead of creating a second run database or transcript-derived success detector.

**Reason:** Existing privacy-safe metadata and durable session state already solve difficult parts of the problem.

## D-008 — Recommended means live-certified, not merely implemented

**Date:** 2026-08-03
**Status:** Accepted

A runtime may be implemented and available without being Recommended. Recommended requires a tested version and a current release-candidate check covering auth, streaming, tool control, stop, reconnect/resume, attachments, and the advertised protection behavior.

**Reason:** Fast-moving external CLIs can drift while static adapters and unit tests remain green.

## D-009 — Patch shrinkwrapped Pi dependencies from exact top-level packages

**Date:** 2026-08-03
**Status:** Accepted, temporary

`pi-coding-agent` 0.82.1 shrinkwraps vulnerable `brace-expansion` and `undici` versions. Bivy carries exact patched top-level versions, npm overrides, a postinstall replacement, lockfile audit metadata, and a CI assertion of the installed nested versions. Remove this mechanism as soon as Pi publishes a corrected shrinkwrap.

**Reason:** Downgrading Pi to the audit tool's suggested older version would regress the integrated agent. Same-major exact replacements close the current advisories while CI verifies the actual installed tree.

## D-010 — Queue ownership uses renewable leases

**Date:** 2026-08-03
**Status:** Accepted

A claimed automation receives a two-minute lease. The node renews it every 30 seconds while work is active, terminal transitions release it, and an expired claim can be atomically reclaimed. Explicit expiry timestamps are stored instead of relying on database interval expressions.

**Reason:** Permanent claims turn a node crash into permanently lost work. Explicit timestamps keep the contract deterministic across PostgreSQL and the in-memory test implementation.

## D-011 — Deterministic checks are package-script based and privacy-minimal

**Date:** 2026-08-03
**Status:** Accepted

Unattended issue runs execute a bounded allowlist of existing package scripts after the agent turn. The default declaration is `test`, `lint`, and `typecheck`; operators can override it. Hosted evidence receives the check name, command hash, status, duration, and exit code, but never command text or output.

**Reason:** Repository-owned scripts are predictable and do not require Bivy to infer a project's build system. Hash-only evidence proves which declared command ran without moving repository content across the hosted boundary.

## D-012 — Ambiguous completion is “Needs review,” never success

**Date:** 2026-08-03
**Status:** Accepted

The shared outcome derivation prefers a PR, changed artifact, deterministic check result, or explicit no-change evidence. A process that merely ends successfully without one of those signals is `Needs review`. The same vocabulary drives the run pill, Inbox, and queue report.

**Reason:** Agent prose and process exit are not reliable proof of a useful outcome. Conservative classification protects unattended trust while preserving the work for human review.

## D-013 — Attachment capacity is a soft cap for referenced history

**Date:** 2026-08-03
**Status:** Accepted

Composer and node request limits are hard. Durable storage rejects new unique blobs at a configurable global admission cap. Its retention sweep removes only unreferenced blobs, oldest first, and reports an over-cap condition rather than deleting referenced history when an operator later lowers the cap. Blob and sidecar writes are atomic.

**Reason:** Bounded disk use matters, but silently breaking a transcript is worse than temporarily exceeding the cap. Operators can see both attachment and event-log usage in `bivy doctor` and adjust retention or remove old sessions deliberately.

## D-014 — Billable runner intent is confirmed before it becomes a send target

**Date:** 2026-08-03
**Status:** Accepted

Interactive ephemeral runners show provider, region/size, available rate estimate, TTL, and teardown behavior before selection. The first message remains the launch gesture, but it can only launch a runner the user explicitly confirmed. Unattended hosted provisioning has a separate enable confirmation.

**Reason:** Confirming at runner selection preserves the simple composer while preventing a normal-looking Send action from being the first disclosure of spend.

## D-015 — Setup success distinguishes node readiness from reply readiness

**Date:** 2026-08-03
**Status:** Accepted

Setup is idempotent, offers model login inline where Bivy owns authentication, prints a stage checklist, and labels a running node with missing model access as incomplete rather than successful. The starter task asks for repository explanation and one low-risk improvement.

**Reason:** Installation is not activation. The user should know the exact failed stage and have a safe path to a useful first response.

## D-016 — Bivy governs the substrate/envelope, not agent collaboration

**Date:** 2026-08-12
**Status:** Accepted — supersedes the developer-platform plan's Phase 5 "Bivy owns agent collaboration" framing.

Agents spawn sub-agents natively; Bivy does NOT inject a `delegate_task` tool or otherwise own/interfere with an agent's collaboration choices. Bivy is the layer on top: it governs the boundary — the sandbox tier the agent enforces natively (`harness/sandbox.ts`), the egress broker injected as `HTTP_PROXY`/`HTTPS_PROXY` env (`harness/net-proxy.ts`), and the MCP proxy injected into the agent's config (`harness/mcp-inject.ts`) — and observes/audits. That envelope applies **transitively** to whatever the agent spawns: a native sub-agent inherits the sandbox tier (same agent process), the egress broker (child processes inherit the proxy env — net-proxy.ts is explicit about "the tools it spawns"), and the MCP proxy (shared config), with no escape path. So "governed multi-agent" requires no Bivy-owned collaboration subsystem; the only optional follow-up is observability (distinctly attributing sub-agent activity, per-adapter cost roll-up).

**Reason:** Bivy's own design principle is "govern the substrate, not the agent" (net-proxy.ts) and "integrations, not agents; no privileged built-in-agent category" (CORE.md / dev-platform plan). A Bivy `delegate_task` tool would reimplement native agent capability, force agent-specific normalization, and interfere with the agent's choices — contradicting that principle. Investigation (2026-08-12) confirmed the governance envelope already covers native sub-agents transitively, so there is no gap to close by building collaboration.
