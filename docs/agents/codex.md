# Codex

OpenAI's operator-installed Codex CLI. The richer integration under
`src/agents/codex/` drives Codex's native app-server: every shell command or file
change it proposes gets an in-chat Approve/Deny card, and sessions resume by their rollout thread id
(`codex-approvals` runtime id). A faster, no-approval variant that only governs
at the sandbox level is also runnable with `BIVY_RUNTIME=codex`.

- **Runtime id:** `codex-approvals` · **Tier:** Supported · **In picker:** Yes
- **Release-tested against:** Codex CLI 0.145.0

## Install

```bash
npm install --global --prefix ~/.local @openai/codex
```

## Authentication

**Auth owner: Codex.** Sign in through the upstream CLI so both ordinary Codex
and Bivy use the same `$CODEX_HOME/auth.json` and account configuration:

```bash
codex login
```

An ambient `OPENAI_API_KEY` still works because Codex itself supports it. The
default integration does not copy a Bivy credential into `CODEX_HOME` or replace
the user's native login or configuration.

## Models

The app-server's picker lists whatever models Codex's own catalog advertises
for your account (its `hello` handshake), defaulting to GPT-5 Codex. The
session-less placeholder shown before that handshake is GPT-5 Codex and GPT-5
under the `openai-codex` provider.

## Resume

Yes. The app-server reconnects a prior thread by its rollout id
(`thread/resume`), with history preloaded from the same on-disk rollout Codex
itself writes — so reopening continues a fully governed session, not a fresh
one.

The plain-exec fallback (`BIVY_RUNTIME=codex`) resumes too, via
`codex exec --json --sandbox <tier> resume <id>`; override the exact args with
`BIVY_CODEX_RESUME_TEMPLATE` if a Codex version changes its flags.

## Known gaps

- The no-approval `codex` exec runtime has no model picker wired — it always
  runs Codex's own default model. Only the app-server (`codex-approvals`)
  variant, the one in the picker, exposes model selection.
- Governance on the exec fallback is sandbox-tier only (no per-tool
  Approve/Deny) — use the picker's Codex for in-chat approvals.

## Run it

Pick Codex in the agent picker, or:

```bash
bivy run codex
```
