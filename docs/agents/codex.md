# Codex

OpenAI's Codex CLI. The agent picker's "Codex" drives Codex's experimental
app-server: every shell command or file change it proposes gets an in-chat
Approve/Deny card, and sessions resume by their rollout thread id
(`codex-approvals` runtime id). A faster, no-approval variant that only governs
at the sandbox level is also runnable with `BIVY_RUNTIME=codex`.

- **Runtime id:** `codex-approvals` · **Tier:** Supported · **In picker:** Yes
- **Release-tested against:** Codex CLI 0.145.0

## Install

```bash
npm install --global --prefix ~/.local @openai/codex
```

## Authentication

**Auth owner: agent.** Codex itself only understands two things: an
`OPENAI_API_KEY` environment variable, or its own `$CODEX_HOME/auth.json`
(what `codex login` writes). For the picker's governed Codex, get a credential
into one of those:

- **Add an OpenAI API key in Bivy** — forwarded to the Codex process as
  `OPENAI_API_KEY` every turn:

  ```bash
  bivy login openai
  ```

- **Or sign in to Codex directly** on the node, which writes its own
  `auth.json`:

  ```bash
  codex login
  ```

Bivy also pre-trusts the session's workspace in Codex's own `config.toml` so
the first run doesn't stall on Codex's "do you trust this directory?" prompt.

Separately, connecting a ChatGPT Plus/Pro subscription in Bivy
(`bivy login openai-codex` — Bivy's OAuth app *is* Codex's own, so the token is
accepted by Codex's backend) auto-mints that same `auth.json` the first time
Codex is launched via `bivy run codex` or the plain `BIVY_RUNTIME=codex` exec
path. That bridge doesn't run for the picker's app-server session yet (see
Known gaps) — but since it's the same file, running `bivy run codex` once to
materialize it also covers the picker's Codex afterward.

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

- **The ChatGPT-subscription auto-mint doesn't reach the picker's session
  yet.** `bivy login openai-codex` provisions `auth.json` for `bivy run codex`
  and the `BIVY_RUNTIME=codex` exec path, not (yet) for a fresh
  `codex-approvals` chat session — use an OpenAI API key or `codex login`
  directly for that one, as above.
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
