# Agent shims (`bivy shim`)

A **shim** shadows an agent's binary on your `PATH` so that starting the agent
from a terminal transparently launches it **inside a Bivy-owned PTY** (via
`bivy run <agent>`) instead of a bare process. You still get the agent's **native
TUI** locally; because the Bivy daemon owns the PTY, the *same live session* is
visible and drivable from the remote web/PWA, and its session id is **pinned at
launch** so it can later be resumed as a governed chat.

```bash
bivy shim install claude     # typing `claude` now launches it in a Bivy PTY
bivy shim status             # list installed shims + whether they win on PATH
bivy shim uninstall claude   # remove it (restores the plain CLI)
```

`shim` and `listen` are aliases for the same command.

## What it does

When you run the shadowed command, the shim decides between two paths:

- **Interactive** (a real TTY, no one-shot flag) → runs `bivy run <agent>`, which
  launches the real agent's native TUI in a daemon-owned PTY. Locally it looks
  and behaves like the native CLI; remotely the same session shows up in the app,
  where you can attach to it as a terminal ("continue on CLI").
- **Headless** (non-TTY stdin — pipes, scripts, CI — or a one-shot flag like
  `claude -p`, `codex exec`, `goose run`) → `exec`s the **real** binary
  unchanged. Tooling and automation are never intercepted.

That headless passthrough is also the **recursion guard**: when Bivy later spawns
the agent's own CLI (e.g. a resumed Claude session in stream-json mode, with
piped stdio), the shim sees a non-TTY invocation and passes straight through to
the real binary.

## Session id pinning

For agents whose CLI supports it (today: `claude --session-id <uuid>`), the shim
run **pins a fresh session id at launch** unless you already chose one (`--resume`,
`-c`/`--continue`, or an explicit `--session-id`). This makes the on-disk session
a known, deterministic target, which is what lets a later "continue as chat"
takeover resume *exactly* this conversation — no transcript-file guessing. The id
is printed at launch, so you can also resume it yourself in a terminal:

```
session id 1a2b… — resume in a terminal with 'claude --resume 1a2b…'
```

Agents without a pin flag simply run without a pinned id (their session is still
resumable by whatever id they assign themselves).

## The tradeoff

This keeps the agent's **native TUI** — but the session runs inside a Bivy PTY, so
it is ~99% native, not a bare process (there's a thin raw-TTY bridge between
your terminal and the daemon PTY: you detach with `Ctrl-\ Ctrl-\`, and the session
survives if you close the terminal). That's the price of the same live session
being drivable from the remote app. Bypass a shim for one run with
`BIVY_SHIM_DISABLE=1 <agent>` (or `BIVY_SHIM_DISABLE=<agent>`).

## PATH ordering

A shim only takes effect if its directory wins over the real binary on your
`PATH`. Shims install into `~/.local/bin` by default (override with `--dir`).

`bivy shim install` **manages this for you**. Rather than rely on your existing
PATH order — which usually loses, because version managers (mise/asdf/nvm/pyenv)
prepend their bin dirs via shell-init hooks that run *during* interactive startup,
after any static `export PATH="$HOME/.local/bin:$PATH"` — it writes a small,
clearly-marked block to the **end** of your shell rc (`~/.zshrc` or `~/.bashrc`),
i.e. *after* the version-manager init, that force-moves the shim dir to the front:

```sh
# >>> bivy shim path >>>
for __bivy_dir in "$HOME/.local/bin"; do
  [ -d "$__bivy_dir" ] || continue
  case ":$PATH:" in
    *":$__bivy_dir:"*)
      PATH=":$PATH:"
      PATH="${PATH//:$__bivy_dir:/:}"
      PATH="${PATH#:}"; PATH="${PATH%:}" ;;
  esac
  PATH="$__bivy_dir${PATH:+:$PATH}"
done
unset __bivy_dir
export PATH
# <<< bivy shim path <<<
```

The block is idempotent (regenerated in place on every install, never
duplicated), covers every shim dir at once, and is **removed automatically when
the last shim is uninstalled**. It's valid in both bash and zsh. The change takes
effect in **new** shells; in the current shell run `hash -r` (zsh: `rehash`) or
restart it. If your login shell isn't bash/zsh, the installer falls back to
printing the manual `export PATH="…:$PATH"` you need.

`bivy shim status` shows, per agent, whether the shim is **active** (wins on
PATH), **shadowed** (installed but the real binary still wins), or **missing** —
resolved through a fresh interactive login shell, so it reflects your *real* PATH
(after your rc and version managers), not the `bivy` process's own PATH.

## General across agents

The mechanism is agent-agnostic — PATH shadowing, real-binary resolution, the
recursion guard, and the `bivy run` handoff are identical for every agent. The
per-agent knowledge is small **data**: a list of "this invocation is headless"
flags (default `-p`/`--print` plus any non-TTY call), and optionally the flag
used to pin a session id. Override the headless list per install:

```bash
bivy shim install aider --headless "--message --yes-always"
```

What differs per agent is how *rich the remote surface* is, which tracks the
agent's Bivy runtime (see [runtime-support-matrix.md](runtime-support-matrix.md)):

- **Remote terminal ("continue on CLI")** — works for any agent, since it's just
  the daemon-owned PTY.
- **Read-only structured chat** — needs a transcript parser (`CLI_PARSERS`);
  Claude/Codex/Goose/Gemini are covered.
- **"Continue as a governed chat"** (kill the PTY, resume the pinned id as a
  structured, approval-gated session) — needs `resume` + `toolInterception`:
  Claude (SDK) and Pi (native) today; other agents as their adapters deepen or
  they speak the bivy-agent-protocol.

## Continue as chat (takeover)

Once a shim/`bivy run` session is live, you can graduate it from the terminal to a
governed chat:

```bash
bivy takeover <termId|session-id>     # or POST /api/terminals/takeover
```

This stops the native TUI (SIGTERMs the PTY the run-terminal owns) and reopens its
**pinned** session as a governed, structured chat on the owning runtime — the
pinned id is the resume target, the PTY is the kill target, so there is never a
second live writer. The response returns the `--resume` command to hop back to a
terminal later. Supported today for agents with a resumable, tool-intercepting
runtime: **Claude** (SDK) and **Pi** (native). Each run-terminal now carries its
`sessionId` and PTY `pid` (`GET /api/terminals`, `terminal.created`) so a client
can offer the action.

## Codex (and other CLI agents)

Codex now supports **structured resume** (not just read-only). Codex has no
launch-time session-id flag to pin, so a takeover **discovers** the session by cwd
(`discoverCodexSessionForCwd`) and reopens it on the resumable Codex runtime,
which continues it via `codex exec resume <id> --json` with history preloaded from
the rollout. Governance is **effect-level** (the exec jail) — not per-tool
approval cards — because Codex's runtime doesn't intercept tools yet. The exact
resume flags are unverified against a live Codex; override the default with
`BIVY_CODEX_RESUME_TEMPLATE` (a JSON arg array with `{id}`/`{tier}` placeholders).

Bivy also reads Codex's on-disk rollout (`$CODEX_HOME/sessions/**/rollout-*.jsonl`)
for a **read-only** reconstruction + `codex resume <id>` handoff:

```
GET /api/codex/sessions              # list adoptable Codex sessions
GET /api/codex/sessions/<id>/messages
```

A *fully governed* (in-chat approval) takeover for Codex is still gated on the
Codex runtime gaining tool interception or Codex speaking the
bivy-agent-protocol. The rollout reader
(`src/runtime/codex-sessions.ts`, unit-tested in `test/codex-sessions.test.ts`)
and the resumable ProcessRuntime (`test/process-resume.test.ts`) are best-effort
and validated against the documented format / via a stub, not yet against a live
Codex.

## Status / roadmap

- **Done:** interactive launch into a Bivy PTY (native TUI, remote-visible/drivable
  terminal) + session-id pinning; PID + pinned id registered on the run-terminal;
  `bivy takeover` / `POST /api/terminals/takeover` "continue as chat" for Claude
  and Pi; read-only Codex session reconstruction (`/api/codex/sessions`).
- **Done:** in-app "Continue as chat" button in the terminal overlay (header +
  Attach menu), over the WS transport.
- **Done:** Codex structured-resume takeover (discover by cwd → `codex exec
  resume` with rollout history; native `--sandbox` governance).
- **Next:** validate the Codex resume flags/format on a live Codex; in-chat
  approvals for Codex (Tier 2); a discovery fallback for truly-unshimmed bare
  sessions.

## Files

- `bin/bivy.mjs` — the `bivy shim` command, the POSIX-sh shim template, the
  session-id pinning in `bivy run`, and the shim registry (`.bivy/shims.json`).
- `bin/shim-path.mjs` — the managed shell-rc PATH block (render/upsert/remove +
  rc-file selection), unit-tested in `test/shim-path.test.ts`.
