# Changelog

All notable changes to Bivy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.0] - 2026-07-24

First public release.

Bivy runs coding agent CLIs on machines you own and makes those sessions
reachable from a phone, browser, or another terminal. This release marks the
point at which the node daemon, CLI, relay, control plane, and web client are
published as source-available software.

### Highlights

- **Ten agents through one interface** — Pi, Claude Code, Codex, OpenCode,
  Gemini CLI, Qwen Code, Goose, Aider, Cline and Crush, each driven through its
  native CLI in a real PTY. Any other command runs via `bivy run -- ./your-agent`.
- **Durable sessions** — an append-only event log and a dedicated git worktree
  per session. Sessions survive detach, daemon restart, and reconnection from a
  different device.
- **Remote access without inbound ports** — the node dials out to a relay that
  forwards end-to-end encrypted frames. Device pairing uses X25519 + HKDF; the
  relay and control plane see ciphertext only.
- **Approvals** — risky shell commands and file edits pause for in-chat
  approval; safe read-only commands run automatically. Modes: `never`, `risky`,
  `always`, `autonomous`.
- **Session forking** — continue a session on a different agent, model, or
  machine, carrying the transcript and uncommitted work.
- **GitHub work queue** — label an issue `bivy` or mention the GitHub App, and a
  node you own claims it, works in an isolated worktree, and opens the PR.
  Multiple GitHub Apps per account are supported — one per personal account or
  organization, each with its own key and `@`-mention handle.
- **Terminal takeover** — `bivy shim install <agent>` makes the native TUI start
  inside a Bivy PTY, so an ordinary terminal session becomes remotely drivable.
- **Credentials stay local** — encrypted vault with `secret://`, `env://`, and
  `op://` (1Password) references resolved before the daemon starts.
- **Any model endpoint** — thirteen providers by API key or OAuth, plus
  self-hosted OpenAI-compatible, Azure, Ollama, LM Studio, vLLM and SGLang.
- **Bring-your-own-cloud runners** — short-lived machines on Fly.io, Hetzner, or
  AWS EC2 using a provider token that stays on your device.
- **Published on npm with provenance** — releases are published from CI via npm
  [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC, no
  long-lived token) and carry a signed provenance attestation; verify with
  `npm audit signatures`.

### Known limitations

- Bivy does not ship an OS-level sandbox jail. Sandbox tiers are enforced
  natively by agents that support them; others are governed at the filesystem,
  MCP, and network layer.
- Queued GitHub issue titles and bodies are stored in plaintext by the control
  plane until a node claims them.
- Credential sync between your own nodes covers Bivy-managed provider keys;
  agent-native logins remain per-machine.
- Aider and Crush cannot resume a session (upstream gaps).
- Self-hosting is unsupported: no SLA, community best-effort.

For the complete trust model and the full list of 0.1 limitations, see
[`docs/security-model.md`](docs/security-model.md).
