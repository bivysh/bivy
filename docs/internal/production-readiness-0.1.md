# Bivy 0.1 — Production-Readiness Review

_Date: 2026-07-25 · Scope: `bivysh/bivy` (node CLI/daemon) + `bivysh/bivy-cloud` (relay / control-plane ops)._

This is a thorough pre-0.1 review of core features, flows, keys, sign-ins, UX,
CLI commands, and help. It records what was tested, what was fixed in this PR,
and tracked follow-ups.

> Operational release-readiness items (secret hygiene, npm publish/provenance,
> the deploy pipeline) are tracked in the private `bivy-cloud` release checklist,
> not here.

## TL;DR

- **Core loop is solid.** The session/runtime/relay data path is unusually
  well-engineered (bounded framing, replay protection, exponential backoff with
  stable-reset, fail-closed approvals, clean signal handling). No `TODO/FIXME/HACK`
  anywhere in `src/`.
- **Baseline is green:** `typecheck` 0 errors, `lint` 0 errors (312 warnings, all
  `any` in tests), **112/112 test suites pass** after this PR.
- **This PR hardens git credential handling (H1)**, adds the missing `bivy version`
  command, hardens the approval boundary, and closes several UX gaps — with tests.
- **`bivysh/bivy` git history is clean** — a full scan of all 314 commits found no
  committed `.env` and no real provider/DB secrets (only `.env.example`, docs, tests,
  and the patterns inside `redact.ts` match those shapes).

## What was tested

| Area | Method | Result |
|---|---|---|
| Build / types | `npm run typecheck` | ✅ 0 errors |
| Lint | `npm run lint` | ✅ 0 errors (312 `any` warnings in tests) |
| Unit/integration | `npm run test:unit` | ✅ 112/112 suites |
| CLI help & UX | ran all read-only subcommands (`--help`, `doctor`, `status`, `agents`, `sessions`, `secrets`, `completions`, `token`, `nodes`, `link`) | ✅ clean, no stack traces |
| Shell completions | `completions bash` → `bash -n` | ✅ valid |
| Auth / keys / sign-in | close code read of `auth`, `identity`, `secrets`, `pairing-crypto`, `e2e`, `git-auth`, `github-app-*` | see findings |
| Core session/runtime/relay | close code read of `relay-client`, `relay-chunk`, `wire-format`, `multiplexer`, `terminal`, `approval`, `question`, teardown paths | see findings |
| bivy-cloud | deploy pipeline, secrets flow, release checklist | see operational notes |

## Fixed in this PR

| ID | Severity | Fix |
|---|---|---|
| H1 | High | **Git credential-helper chain is now reset before bivy's helper is added** (`src/git-auth.ts`). Previously a pre-existing host `github.com` helper (osxkeychain, `gh`, `store`, manager-core) was consulted *first* and could hand an agent the human's personal, broadly-scoped token instead of bivy's scoped short-lived one. Both `credConfigArgs()` (daemon-run git) and `configureRepoCredentialHelper()` (agent-run git) now emit empty `helper=` resets so only bivy's helper runs. Regression test added; this also fixes the previously env-flaky `git-auth.test.ts`. |
| — | High (UX) | **`bivy version` / `--version` / `-v` added** (`bin/bivy.mjs`). Previously all three printed `Unknown command` and exited non-zero — a notable gap for a public CLI and bad for scripts/CI. Reads version from `package.json`, best-effort. Smoke test added (`test/cli-version.test.ts`). |
| M1 | Medium | **`ApprovalManager.history` is now a bounded ring buffer (200)** (`src/approval.ts`). A long-lived daemon previously accumulated every approval forever, bloating memory and every `/api/approvals` + session-list scan. |
| M2 | Medium | **Pending approvals are now cancelled on session close/detach** (`src/approval.ts` `cancelForSession` + wired into both teardown paths in `src/server.ts`). Previously a killed session's ApprovalCard haunted every connected client for up to 5 minutes. Mirrors the existing `QuestionManager` behavior. Test added (`test/approval.test.ts`). |
| M3 | Medium | **Guardian interceptor is now fail-closed** (`src/server.ts`). The interceptor *is* the security boundary (policy + approvals + questions); any throw now BLOCKS the tool rather than deferring to the SDK's default outcome. |
| — | Medium (UX) | **Shell completions now list all documented top-level commands** (`bin/bivy.mjs`) — added `send`, `kill`, `link`, `agents:install`, `update:log`, `github:connect`, `voice`, `version`. |
| — | Low (UX) | Help-text capitalization fixed for `update` / `update:log`. |

## Operational release-readiness

Deploy/publish and secret-hygiene items are tracked in the private `bivy-cloud`
release checklist, not in this repo. The one code-adjacent item to flag here:

- **npm publish with provenance** — the documented `curl … | bash` / `npm i -g @bivy/bivy`
  install path depends on the package being published from CI with provenance
  attestations (see `docs/releasing.md`).

The `bivysh/bivy` git history was scanned and is clean (see TL;DR).

## Tracked follow-ups (not blocking, recommend before/just after 0.1)

Auth/keys (from the security pass):
- **M — Redaction gaps** (`src/redact.ts`): does not cover bivy's own device tokens
  (`mesh_…`), enrollment/session tokens in `relay.json`, JWTs (`eyJ…`), pairing/room
  secrets, or generic `Authorization: Bearer`. An agent running `cat ~/.bivy/relay.json`
  or `env` could land these in a synced transcript. Add patterns; ideally deny agents
  read access to the data dir.
- **M — Loopback auth bypass on multi-user hosts** (`src/auth.ts`): default allows any
  loopback caller with no token; a different OS user on a shared host can drive the
  daemon. Document prominently; consider token-required default on multi-user hosts.
- **M — `defaultSecretsDir` falls back to `process.cwd()/.bivy`** (`src/secrets.ts`):
  can write the AES master key inside a repo tree. Fall back to `~/.bivy` like
  `git-auth.ts`.
- **M — Non-atomic writes + regenerate-on-parse-failure** (`src/device-registry.ts`,
  `src/identity.ts`): a crash mid-write can truncate `pairing.json`/`node.json`, and a
  parse failure silently regenerates identity/room keys, orphaning paired devices. Use
  atomic tmp+rename; fail loudly instead of regenerating.
- **L** — `secrets.ts readJson` swallows all read errors (risk of overwrite-to-empty);
  data-dir `mkdir` without `mode: 0o700`; magic-link / webhook-secret printed to stdout
  in explicit dev/manual fallbacks.
- Follow-up pass recommended on `src/relay-client.ts` transport framing and `src/policy/*`
  defaults (not fully covered in the time box).

Core/runtime (from the core pass):
- **L — `ProcessSession.abort` signals only the direct child** (`src/runtime/process.ts`),
  can orphan grandchildren for generic-CLI agents that fork (pty-runner already does this
  right). Also capture `this.child` in a local before the SIGKILL timer.
- **L — `bivy exec` exits 0 on a mid-turn disconnect** (`src/exec.ts`) if partial text
  arrived; only exit 0 when completion was observed.
- **L — Ephemeral proxy follows redirects** (`src/ephemeral-exec.ts`); allowlist is
  checked on the initial URL only. Use `redirect: "manual"` and re-validate.

CLI/UX (from the CLI pass):
- **M — Subcommand `--help` is ignored** and the command runs anyway (e.g. `doctor --help`
  runs the health check). Harmless for read-only commands today, but add per-command help
  or at least don't execute.
- **L — Invalid subcommands exit 0** (`secrets bogus`, `nodes bogus`) instead of non-zero.
- **L** — `bivy run` help lists a stale agent sample vs. `bivy agents`; `link` prints a
  pairing payload with `pairSecret` readily — confirm that's intended.

## What's solid (keep as-is)

- Token storage: raw device tokens returned once, only SHA-256 hashes persisted (0600),
  `verifyToken` uses `timingSafeEqual`.
- Pairing crypto: X25519 → HKDF-SHA256 with distinct `info` labels per purpose; constant-time
  proof verification; single-use high-entropy pair secret.
- E2E envelope: AES-256-GCM, random IV per message, authenticated framing + bounded replay guard.
- Local secrets: AES-256-GCM, atomic tmp+rename at 0600, ENOENT-only key-regen guard.
- GitHub App key isolation: private key stays on the node; short-lived JWT → 1h installation tokens.
- Relay reconnection, framing/reassembly bounds, replay protection, coalescer, PTY handling,
  and shutdown are all bounded and defensive.
- Approvals/questions fail closed (deny on timeout/reject/block; `bypassPermissions` deliberately avoided).
- bivy-cloud deploy pipeline: strict ref allowlisting (production requires an immutable tag/SHA),
  disciplined secrets flow, fail-safe deploy scripts with external auth smoke checks.
