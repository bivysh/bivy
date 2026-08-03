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

## D-003 — Preserve account-free Local CLI mode

**Date:** 2026-08-03
**Status:** Accepted

`bivy setup` will offer Local CLI, Bivy Cloud remote, and self-hosted remote. Local mode installs and starts the node without relay enrollment. Remote access remains the primary differentiated upgrade, but not an activation gate.

**Reason:** This satisfies `CORE.md`, lowers first-value friction, and gives users a safe way to evaluate Bivy before account creation.

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
