# Bivy security model

This document describes what Bivy protects, what it does not protect, and where
the boundaries are. It is written to be checkable: every claim below points at
the code that implements it.

To report a vulnerability, see [`../SECURITY.md`](../SECURITY.md).

## Architecture in one paragraph

Bivy has three parts. The **node** is a daemon you run on your own machine; it
holds your code, your credentials, and the agent processes. The **control
plane** is a hosted service that holds accounts, node registration, billing, and
routing metadata. The **relay** is a hosted WebSocket router that lets a remote
device reach a node behind NAT. The node dials the relay outbound; no inbound
port is opened.

The node is the data plane. The control plane and relay are not.

## Trust model

### What the node holds

- Your source code and workspaces.
- Session transcripts and tool-activity logs, on local disk under `.bivy/`.
- Provider credentials (model API keys, OAuth records, GitHub tokens), in the
  local vault (`.bivy/secrets.json`, AES-256-GCM) or referenced out to
  1Password/env — see [`key-management.md`](key-management.md).
- The node's X25519 identity keypair and the current symmetric room key, in
  `.bivy/pairing.json` (mode `0600`) — `src/device-registry.ts`.
- Device access tokens, stored as SHA-256 hashes only; the raw token is
  returned once at creation and never recoverable — `src/identity.ts`.

### What the control plane sees

The control plane stores account and routing metadata. Concretely, its schema
(`services/control-plane/src/postgres-store.ts`) holds accounts, sessions,
nodes, paired-device public keys, push subscriptions, single-use relay tickets,
and a `session_index` of `(node_id, session_id, status, source, branch,
title_enc, updated_at)`. Session titles are stored encrypted (`title_enc`).

It does **not** receive prompts, transcripts, diffs, or workspace files.

Two exceptions you should know about:

- **Model-auth vault.** When hosted credential sync is on, the node encrypts a
  vault snapshot locally and uploads only ciphertext, plus per-node wrapped keys
  (`model_auth_vaults`, `model_auth_wrapped_keys`). The control plane cannot
  unwrap them. See [`credential-sync.md`](credential-sync.md).
- **GitHub work queue.** The `work_items` table stores issue `title`, `body`,
  `repo`, and `url` in plaintext, because the control plane receives them from a
  GitHub webhook and routes them to a node. If you use the work queue, issue
  text transits and rests on the control plane. See
  [`github-work-queue.md`](github-work-queue.md).

### What the relay sees

The relay reads only the envelope routing field. For data frames the opaque
payload is forwarded verbatim and is never parsed, logged, or stored
(`services/relay/src/index.ts`). It does not hold the room key, so it cannot
read session content or forge commands. A compromised relay can route, drop,
delay, and observe metadata (which node, which client, frame sizes, timing).

The relay never receives a reusable bearer token. A node or client exchanges its
long-lived token for a short-lived, **single-use relay ticket**, minted directly
against the control plane over TLS, and presents only that ticket
(`src/relay-client.ts`, `mintTicket`). The relay consumes the ticket on a
one-shot introspection call, so a fully compromised relay cannot replay it to
mint link grants, list nodes, or otherwise act as the account.

## End-to-end encryption

Session frames between a node and its paired devices are encrypted with
**AES-256-GCM** under a 32-byte symmetric **room key** that never transits the
relay in the clear (`src/e2e.ts`).

Wire format is `[12-byte IV | 16-byte GCM tag | ciphertext]`, base64.

**Anti-replay.** GCM stops forgery and tampering but not verbatim replay of a
captured frame. Bivy wraps each payload with a timestamp and a random nonce
*inside* the authenticated plaintext, and the receiver rejects frames outside
the freshness window or with a nonce it has already seen (`ReplayGuard` in
`src/e2e.ts`).

## Pairing (X25519)

The room key is not shipped in the QR code. Pairing is an X25519 handshake
(`src/pairing-crypto.ts`, `src/device-registry.ts`):

1. The node keeps a long-term X25519 identity keypair. Its public key goes in
   the QR, which reaches the device out of band on a trusted screen — so the
   device cannot be fooled about node identity.
2. The QR also carries a high-entropy, single-use, 5-minute `pairSecret` that
   never crosses the relay.
3. The device sends its own public key over the relay together with a proof:
   `HMAC-SHA256(pairSecret, devicePublicKey)`. It never sends the secret.
4. The node matches the proof against outstanding secrets using a constant-time
   compare, consumes the secret (single use), records the device's public key,
   and returns the room key sealed under an ECDH-derived wrap key
   (`HKDF-SHA256(ECDH(node_priv, device_pub))`, domain-separated by purpose).

Because the relay never saw the QR, it cannot forge the proof or derive the wrap
key. Worst case it can make a pairing attempt fail; it cannot leak the room key.

## Local daemon exposure (cross-origin and DNS rebinding)

The node's HTTP/WebSocket API on `localhost:4317` can run shell commands and
edit files. By default it authorizes any **loopback** caller without a token so
the local UI works out of the box (`BIVY_REQUIRE_LOCAL_AUTH=1` forces token auth
even on loopback).

That default would otherwise let any web page you visit drive your agent. The
actionable surface (`/api`, `/ws`) therefore rejects requests whose browser
`Origin` is not local **and** whose `Host` header is not local — the latter is
what defeats DNS rebinding (attacker domain resolving to `127.0.0.1`). See
`requestOriginAllowed` in `src/auth.ts`.

Allowed hosts are loopback, RFC1918 private ranges (`10/8`, `192.168/16`,
`172.16/12`), link-local (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`, used
by Tailscale), IPv6 unique-local (`fc00::/7`), and `.local` / `.ts.net` /
`.internal` / `.localhost` names — so LAN, mDNS, and Tailscale access keep
working. Requests with no `Origin` at all (CLI, curl, native clients) pass the
Origin check and are still subject to the Host check.

Escape hatches:

- `BIVY_ALLOWED_HOSTS=host1,host2` — allow extra hostnames, e.g. a reverse-proxy
  domain fronting the node.
- `BIVY_ALLOW_ANY_ORIGIN=1` — disable the check entirely. Not recommended.

### Local UI bootstrap secret

On a multi-user host every local account shares `127.0.0.1`, so loopback is not
isolation. The daemon generates a 32-byte per-process bootstrap secret, prints a
one-time URL on startup, and writes the secret to `.bivy/bootstrap.json` (mode
`0600`). The loopback endpoint that mints the local UI's device token requires
that secret (constant-time compared), so only the user who launched the daemon —
and can read its stdout or the `0600` file — can bootstrap (`src/server.ts`,
`bootstrapSecretAccepted`).

- Open the UI with `bivy open`, or the URL printed at startup — not by typing
  the bare `http://localhost:<port>` into a fresh browser.
- On a trusted single-user machine, `BIVY_OPEN_BOOTSTRAP=1` drops the secret
  requirement and restores zero-friction loopback bootstrap.

## Authentication and device enrollment

- Remote callers (relay, paired devices) must present a valid device token.
- Device tokens are `mesh_<32 random bytes, base64url>`. Only the SHA-256 hash
  is written to `.bivy/node.json` (mode `0600`); verification uses
  `timingSafeEqual` (`src/identity.ts`).
- Nodes enroll against the control plane and receive a one-time `enr_`
  enrollment token. Enrollment honours the plan's optional `maxNodes` cap; no plan
  currently sets one, so node enrollment is unlimited on every tier.

### Revoking one device

Linked devices live in the node-local registry `.bivy/pairing.json`, each with
its X25519 public key. Revoking a device (`DELETE /api/devices/:id` on the node)
drops it, **rotates the room key**, and **re-wraps the new key to the remaining
devices** using their stored public keys. The revoked device never receives the
new key and its old key is dead; the others keep working without re-pairing
(`PairingStore.revokeDevice`).

### Revoking everything

To force every device to re-link, remove all linked devices in **Signed-in
devices**; each removal rotates the room key, and removing the last leaves no
device holding a valid key. For a harder reset that also rotates the node's own
pairing identity, delete `.bivy/pairing.json` on the node and restart: the node
generates a fresh keypair and room key, so every device must re-pair from a new
QR.

Revoking the node itself is done from the control plane (Account → Your nodes).

## The approval gate

Bivy's safety model is a **hard floor plus a configurable prompt level**
(`src/guard.ts`, `src/policy/policy-engine.ts`).

The hard floor applies in **every** mode, including `never`:

- Catastrophic bash commands are denied outright: `rm -rf /` (and `~`, `/*`),
  `mkfs`, `dd of=/dev/sd*`, redirects to raw block devices, the classic fork
  bomb, `chmod -R 777 /`, and `shutdown`/`reboot`/`halt`/`poweroff`.
- `write` and `edit` calls whose resolved path escapes the session workspace are
  denied outright.

Above the floor, `approvalMode` decides how often it asks:

| Mode | Behaviour |
| --- | --- |
| `never` | No prompting. Hard floor still applies. |
| `risky` | Heuristically risky bash (`rm`, `mv`, `chmod`, `sudo`, `curl`, `git commit/push/reset`, package installs, output redirection, …) plus all `write`/`edit` calls prompt. |
| `always` | Every `bash`/`write`/`edit` call prompts. |
| `autonomous` | Runs unattended, but "backstop" actions still prompt: force-push, push to `main`/`master`, `npm publish`, `kubectl/terraform apply`, `docker push`, `fly/vercel/netlify deploy`, `gh release create`, sending mail from the shell, and `sudo`. |

Integration tools flagged risky (send email, upload, …) always prompt,
regardless of mode.

Pending approvals expire after 5 minutes and expire **denied**
(`src/approval.ts`).

Choosing `never` grants any connected client unattended code execution on the
node, bounded only by the hard floor. That is a real decision — make it
deliberately.

## Sandboxing

There is **no Bivy-owned OS jail**. Bivy does not implement seccomp, namespaces,
Seatbelt, or a container boundary of its own. Understanding what you actually
get requires splitting agents into two groups (`src/harness/sandbox.ts`).

Bivy exposes one policy knob with three tiers, borrowing Codex's vocabulary:

| Tier | Intent |
| --- | --- |
| `read-only` | May read the workspace. No writes, no network. |
| `workspace-write` (default) | May read/write the worktree; escapes need approval. |
| `danger-full-access` | No in-agent limit. Explicit opt-out. |

Precedence: per-session override > `BIVY_SANDBOX` env > node setting >
`workspace-write`.

**Agents that ship their own sandbox enforce the tier natively.** Bivy maps the
tier onto the agent's own flags and lets the agent do the enforcement — this is
real, in-process enforcement (a read-only Codex session physically refuses to
write):

- Codex — `--sandbox <tier>`; the app-server path also sets
  `approvalPolicy: "untrusted"` on the restrictive tiers, so each command and
  patch also surfaces as a Bivy approval card.
- Gemini CLI and Qwen Code — `--approval-mode plan|auto_edit|yolo`.
- Claude Agent SDK — `permissionMode plan|default|bypassPermissions`, with
  Bivy's `canUseTool` guard still gating risky tools.

**Agents without a native sandbox** (Goose, OpenCode, Aider, Cline, Crush, and
the generic adapters) get **no OS-level containment**. They run as your user,
with your filesystem permissions, governed only by Bivy's three effect channels:

1. **Filesystem** — the workspace-escape check in `src/guard.ts`, applied to the
   agent's `write`/`edit` tool calls.
2. **MCP** — Bivy rewrites the agent's MCP config so every server launches
   behind `bivy mcp-proxy`, mediating the JSON-RPC so every MCP tool call can be
   inventoried, logged, and denied (`src/harness/mcp-proxy.ts`).
3. **Network** — an optional local egress broker injected via
   `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`, which sees and can deny outbound
   connections by host (`src/harness/net-proxy.ts`).

See [`runtime-support-matrix.md`](runtime-support-matrix.md) for the per-agent
column ("Native sandbox" vs "Effect-level (FS/MCP/net)" vs "Boundary only").

### Honest limits of that governance

- The FS check only sees tool calls the agent routes through Bivy. An agent that
  shells out (`bash`) can write anywhere your user can. The catastrophic-command
  deny list is a regex heuristic, not a sandbox — it is trivially bypassable by
  an adversarial agent (obfuscation, base64, a script file) and is designed to
  catch accidents, not attacks.
- The MCP proxy governs MCP tool calls. It does not govern anything the agent
  does outside MCP.
- The egress broker is **opt-in** (`BIVY_EGRESS_PROXY`) and ships
  observe-and-log with default-allow. It relies on the agent honouring proxy env
  vars; anything using raw sockets or ignoring `HTTP_PROXY` bypasses it. For
  HTTPS it sees `host:port` via `CONNECT`, not content.
- If you need a real isolation boundary for an untrusted agent or untrusted
  code, run the node inside a VM or container you control.

## Secret redaction in logs

Bivy persists transcripts and tool-activity sidecars as JSON under `.bivy/`, and
those files sync to the web/PWA. Anything an agent prints — e.g. `git remote -v`
surfacing the token baked into a clone's origin URL — would otherwise land in
cleartext in a synced log.

Redaction runs at the single persistence choke point (`EventLog.flush`) and is
structure-preserving: it only shortens string values, so JSON stays valid
(`src/redact.ts`). It masks GitHub tokens in every current shape (`ghp_`,
`gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), the password half of any URL
userinfo (`scheme://user:SECRET@host`), and common model/provider and SaaS API
keys with distinctive prefixes (OpenAI/Anthropic `sk-…`, Stripe `sk_live_`/
`sk_test_`/`rk_…`, Groq `gsk_…`, xAI `xai-…`, Google `AIza…`, AWS `AKIA…`,
Slack `xox[baprs]-…`).

This is pattern-based. It does not catch a secret shape Bivy has no pattern for.

## Known limitations for 0.1

Bivy 0.1 is an early public release. These are the things we would want a
security-conscious user to know before trusting it with anything sensitive.

1. **No Bivy-owned OS sandbox.** As above: agents without a native sandbox run
   as your user with your permissions. Bivy's governance is effect-level and
   partial. Do not treat Bivy as an isolation boundary.
2. **The hard-floor deny list is heuristic.** Regex over a shell command string.
   It stops accidents, not a determined agent.
3. **Loopback is trusted by default.** Any process running as any user on the
   machine can reach `localhost:4317`; only the bootstrap-secret gate protects
   the token-minting endpoint. Set `BIVY_REQUIRE_LOCAL_AUTH=1` on shared hosts.
4. **`BIVY_ALLOW_ANY_ORIGIN=1` fully disables the rebinding/cross-origin
   guard.** It exists as an escape hatch; using it re-opens the attack the guard
   was written to close.
5. **The work queue stores issue text in plaintext on the control plane.**
   `work_items.title`/`body` are not encrypted. If your issue bodies are
   sensitive, do not use the hosted work queue.
6. **The local vault's wrapping key sits next to the vault.**
   `.bivy/secrets.key` and `.bivy/secrets.json` are both on the same disk at
   mode `0600`. This protects against other local users, not against someone who
   can read your home directory or your backups. Use the 1Password or env
   reference backends if you need better.
7. **No OS keychain integration yet.** Related to the above; node-held secrets
   are file-based.
8. **No recovery story for the model-auth vault.** If you lose every node and
   device that can unwrap it, the ciphertext on the control plane is
   unrecoverable by design. There is no escrow.
9. **Relay hardening is incomplete.** TLS termination is expected to be provided
   in front of the relay by the operator. Frame-size and per-socket
   message-rate limits exist, but per-account connection caps and quotas do not
   yet. Rooms are in-process, so the relay does not horizontally scale.
10. **Self-hosted deployments are your responsibility.** `RELAY_SECRET`,
    database credentials, and TLS configuration are operator-supplied; a weak or
    shared `RELAY_SECRET` compromises the relay/control-plane trust boundary.
    See [`self-host.md`](self-host.md).
11. **Metadata leaks to the relay.** Which node, which client, when, how much,
    and how often. E2E encryption hides content, not traffic patterns.
12. **Redaction is pattern-based.** It covers GitHub tokens, URL userinfo, and
    common provider/SaaS key shapes with distinctive prefixes (OpenAI/Anthropic,
    Stripe, Groq, xAI, Google, AWS access-key ids, Slack). A credential shape
    Bivy has no pattern for — including generic high-entropy secrets — will be
    persisted verbatim.
13. **No third-party security audit.** Bivy 0.1 has not been externally audited.
14. **Approvals expire denied after 5 minutes.** A long-running unattended
    session that hits an approval will stall and then fail rather than proceed.

## Reporting

Security issues go through GitHub private vulnerability reporting. See
[`../SECURITY.md`](../SECURITY.md) for the process, scope, and safe harbour.
