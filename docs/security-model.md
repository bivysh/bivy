# Bivy security model

This document describes what Bivy protects, what it does not protect, and where
the boundaries are. It is written to be checkable: every claim below points at
the code that implements it.

To report a vulnerability, see [`../SECURITY.md`](../SECURITY.md).

## Architecture in one paragraph

Bivy has three parts. The **node** is a daemon you run on your own machine; it
holds your code, your credentials, and the agent processes. The **control
plane** is a hosted service that holds accounts, node registration, and
routing metadata. The **relay** is a hosted WebSocket router that lets a remote
device reach a node behind NAT. The node dials the relay outbound; no inbound
port is opened.

The node is the data plane. The control plane and relay are not.

## Trust model

### What is end-to-end encrypted, and from whom

The short version, before the detail:

| Path | Relay sees plaintext? | Control plane sees plaintext? | Who you trust for device authorization |
| --- | --- | --- | --- |
| QR / `bivy link` pairing (hosted or self-hosted control plane) | **Never** | **Never** | The node — the QR carries the node's public key and a single-use secret out of band |
| Account pairing (a signed-in browser links a node from the app) | **Never** | **Never** for session content | The **control plane** — the node wraps the room key for any device key the control plane authorizes |
| Hosted ephemeral provisioning (control plane launches the machine) | **Never** | It **holds the room key** (escrowed) | The control plane — this is an explicit hosted-custody mode |
| Terminal CLI on the node (`bivy run`, `bivy attach`) | n/a — nothing leaves the machine | n/a | Nobody |

"Never" for the relay is unconditional: there is no plaintext or downgrade mode
in the wire protocol. The control-plane column depends on the path; the
[Known limitations](#known-limitations-for-0x) spell out each of the trust
points in the last column.

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

For interactive terminal/browser/phone sessions, it does **not** receive prompts,
transcripts, diffs, or workspace files: those frames are end-to-end encrypted
between the node and its paired devices.

That includes attachments and the Session/Run **Artifacts** sheet (screenshots,
reports, benchmark results, build archives an agent surfaces with `bivy attach`
/ `attach_to_chat`, or a user uploads). Attachment bytes live only in the node's
content-addressed `AttachmentStore` (`src/session/attachment-store.ts`); the
Artifacts sheet's projection (`packages/core/src/artifacts.ts`) is a pure,
client-side fold over the transcript the E2E channel already delivers — it adds
no new server, no new wire command, and reaches the control plane not at all.
The `artifact` marking (`bivy attach --artifact`) is carried the same way: it
rides the same end-to-end-encrypted `attachment` event/history payload as the
filename and caption it sits next to, never as a separate control-plane call.
The one exception, as noted below, is a GitHub-queue run's bounded
`output.artifactUrl` — an external link a run reports as its outcome, not a
filename or byte.

Inbound automations have a different boundary because Slack and generic webhook
senders call the control plane directly. The exceptions are:

- **Model-auth vault.** When hosted credential sync is on, the node encrypts a
  vault snapshot locally and uploads only ciphertext, plus per-node wrapped keys
  (`model_auth_vaults`, `model_auth_wrapped_keys`). The control plane cannot
  unwrap them. See [`credential-sync.md`](credential-sync.md).
- **GitHub work queue.** The `work_items` table stores source identifiers
  (`repo`, issue number, and `url`) and routing metadata in plaintext. Issue/
  comment title and body transit the GitHub webhook but are **not** persisted —
  the claiming node fetches the live text directly from GitHub with its own
  credentials, immediately before use. See
  [`github-work-queue.md`](github-work-queue.md).
- **Slack and generic automation webhooks.** Their instruction text necessarily
  reaches the control plane in plaintext because Slack/the webhook sender calls
  it directly. Bivy stores the Slack prompt as the queue title and stores the
  generic event instruction plus fixed template in the queue body until that
  item is deleted. Do not put secrets in either. Generic hooks use a
  high-entropy signing secret; the control plane verifies
  `X-Bivy-Signature-256` as HMAC-SHA256 over the exact bytes before parsing or
  persisting. Requests are capped at 64 KiB. Stable account-scoped idempotency
  keys are recommended; providers that cannot add one are assigned a unique key.
  Payloads cannot select runtimes, models, shell commands, JavaScript, or
  executable templates. Hook secrets and request bodies are never logged.
  Rotation immediately invalidates the old secret, and revocation keeps only a
  disabled endpoint with a newly randomized secret.

Provider-native JSON objects and arrays are accepted entirely as untrusted event
context. Senders that need Bivy routing fields can opt into this closed envelope
(unknown fields are rejected once `version` or `instruction` is present):

```json
{
  "version": "1",
  "instruction": "Run the test suite and investigate failures",
  "title": "CI failed",
  "sourceUrl": "https://ci.example/builds/123",
  "externalId": "build-123",
  "routing": "macbook",
  "metadata": { "branch": "main", "attempt": 2 }
}
```

`instruction` is required in the envelope. The other envelope fields are
optional; `metadata` accepts at most 20 bounded scalar values and must not contain
secrets. Signing can be disabled for providers that cannot set custom headers;
when enabled, requests require `X-Bivy-Signature-256: sha256=<hex HMAC>`.
Responses are stable:
`202 accepted`, `200 duplicate`, `401 invalid_signature`, `410 disabled`,
`413 payload_too_large`, and `429 quota_exhausted`.

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

### Account pairing (the control plane vouches for the device)

A browser that is already signed in to the app can link a node without a QR.
It sends `pair.account` over the relay with its X25519 public key and its
account session token; the node forwards both to the control plane
(`POST /node/authorize-client`, `authorizeAccountPairing` in
`src/remote/relay-client.ts`) and, on an `ok`, wraps the room key for that
device key exactly as in step 4 above (`PairingStore.trustDevice`,
`src/device-registry.ts`). The browser, for its part, learns the node's public
key from the first pairing frame it receives over the relay
(`handlePairFrame` in `packages/core/src/transport-relay.ts`) — trust on first
use — rather than from an out-of-band QR.

The relay still cannot read anything: the room key is wrapped under ECDH
between the node and the device, and the relay holds neither private key. What
changes is *who decides which device keys get the room key*: on this path it is
the control plane. A malicious or compromised control plane could authorize a
device it controls, or collude with the relay to substitute public keys during
the handshake. QR / `bivy link` pairing does not depend on the control plane
for that decision, and self-hosting the control plane puts it under your own
control.

## Local daemon exposure (cross-origin and DNS rebinding)

The node's HTTP/WebSocket API on `127.0.0.1:4317` can run shell commands, edit
files, open terminals, and hand out repo tokens. **It hosts no web UI**:
`http://localhost:4317` returns one line of plain text, and `bivy open` opens
the *control plane's* web app (hosted, or one you self-host), which reaches
the node through the relay. The daemon binds to loopback only unless you set
`BIVY_HOST` (`src/server.ts`); remote devices never connect to this port
directly, because the node dials the relay outbound.

**Same-user callers on loopback need no token by default.** `isAuthorized()`
in `src/auth.ts` accepts a loopback connection with no device token when
`loopbackAllowed()` is true, which is the case on a host Bivy believes has a
single human user. `isMultiUserHost()` decides that: on Linux it counts
`/etc/passwd` accounts with a real login shell and a normal (non-system) UID;
on macOS it counts real accounts from `dscl . -list /Users UniqueID`. More than
one means the bypass is off, because loopback is shared by every local account
and is not isolation between them. Windows detection isn't implemented, so the
bypass stays on there today. `BIVY_REQUIRE_LOCAL_AUTH=1` always forces token
auth even on loopback (e.g. Windows, or if you don't trust the detection); `=0`
always keeps the bypass on even if the host looks shared.
`BIVY_MULTI_USER_HOST=1`/`=0` overrides just the detection. Detection is
deliberately conservative (biased toward false negatives) so it never surprises
a single-user machine into requiring a token it never needed before.

When the bypass is off, every `/api` and `/ws` caller — including the CLI —
must present a device token. Loopback callers get one from
`POST /api/auth/bootstrap`, which is gated by a per-process **bootstrap
secret**: 32 random bytes generated at daemon start, printed to its stdout and
written to `.bivy/bootstrap.json` (mode `0600`), and compared in constant time
(`bootstrapSecretAccepted`, `src/server.ts`). Only the OS user who launched the
daemon — and can read its stdout or the `0600` file — can mint a token this
way. The same gate protects `GET /api/git-credential`, the loopback endpoint
the git credential helper uses to fetch short-lived repo tokens.
`BIVY_OPEN_BOOTSTRAP=1` drops the secret requirement on a trusted single-user
machine.

**Cross-origin and DNS rebinding.** Because loopback callers may be tokenless,
any web page you visit could otherwise open a cross-origin WebSocket to
`ws://127.0.0.1:4317/ws` and drive the agent. The actionable surface (`/api`,
`/ws`) therefore rejects a request whose browser `Origin` is not a local/private
name, and independently rejects a request whose `Host` header is not local —
the latter is what defeats DNS rebinding (attacker domain resolving to
`127.0.0.1`). See `requestOriginAllowed` in `src/auth.ts`.

Hosts and origins counted as local are loopback, RFC1918 private ranges (`10/8`,
`192.168/16`, `172.16/12`), link-local (`169.254/16`, `fe80::/10`), CGNAT
(`100.64/10`, used by Tailscale), IPv6 unique-local (`fc00::/7`), and `.local` /
`.ts.net` / `.internal` / `.localhost` names — so LAN, mDNS, and Tailscale
access keep working when you deliberately bind with `BIVY_HOST`. Note the
flip side: a page served from any private-network address (a LAN device, a
Tailscale peer, another local dev server on `.localhost`) is treated as a local
origin. Requests with no `Origin` at all (CLI, curl, native clients) and
requests with `Origin: null` pass the Origin check and are subject only to the
Host check.

Escape hatches:

- `BIVY_ALLOWED_HOSTS=host1,host2` — allow extra hostnames, e.g. a reverse-proxy
  domain fronting the node.
- `BIVY_ALLOW_ANY_ORIGIN=1` — disable the check entirely. Not recommended.

## Authentication and device enrollment

- Remote callers (relay, paired devices) must present a valid device token.
- Device tokens are `mesh_<32 random bytes, base64url>`. Only the SHA-256 hash
  is written to `.bivy/node.json` (mode `0600`); verification uses
  `timingSafeEqual` (`src/identity.ts`).
- Nodes enroll against the control plane and receive a one-time `enr_`
  enrollment token.

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

For runtimes that expose structured tool calls, Bivy's policy model is a
**heuristic floor plus a configurable prompt level** (`src/guard.ts`,
`src/policy/policy-engine.ts`). The runtime picker reports the effective
protection mechanism for the selected path.

Within an intercepted tool path, the floor applies in **every approval mode**,
including `never`:

- Known catastrophic shell commands are denied outright: `rm -rf /` (and key
  system roots), `mkfs`, `dd of=/dev/sd*`, redirects to raw block devices, the
  classic fork bomb, `chmod -R 777 /`, and shutdown commands. This rule also
  holds at **every sandbox tier**, including `danger-full-access`: the policy
  engine evaluates it before the full-access short-circuit
  (`catastrophicFloor` in `src/guard.ts`, `PolicyEngine.decideToolCall`), so
  nothing configurable sits above it.
- Structured `write` and `edit` calls whose resolved path escapes the session
  workspace are denied outright on the `read-only` and `workspace-write` tiers.
  `danger-full-access` is the explicit opt-out from the workspace boundary and
  from approval prompts (that is what "full access" means) — but not from the
  catastrophic-command rule above.

This floor does not apply to operations Bivy cannot observe. A process adapter
without structured interception can shell out or write as the OS user. The
heuristics catch common accidents; they are not an adversarial boundary.

Above the floor, `approvalMode` decides how often it asks:

| Mode | Behaviour |
| --- | --- |
| `never` | No prompting. Heuristic floor still applies on intercepted tool paths only. |
| `risky` | Heuristically risky bash (`rm`, `mv`, `chmod`, `sudo`, `curl`, `git commit/push/reset`, package installs, output redirection, …) plus all `write`/`edit` calls prompt. |
| `always` | Every `bash`/`write`/`edit` call prompts. |
| `autonomous` | Runs unattended, but "backstop" actions still prompt: force-push, push to `main`/`master`, `npm publish`, `kubectl/terraform apply`, `docker push`, `fly/vercel/netlify deploy`, `gh release create`, sending mail from the shell, and `sudo`. |

Integration tools flagged risky (send email, upload, …) always prompt,
regardless of mode.

Pending approvals expire after 5 minutes and expire **denied**
(`src/approval.ts`).

A prompt raised by `risky`/`always` mode can be answered "Allow … this
session": the node then stops asking for the same program + subcommand
(`git status`, `npm test`) or the same tool (`edit`) until that session closes.
Rules are held in the node's memory only (`src/policy/session-allow.ts`) —
never persisted, never shared across sessions — and are consulted only for
mode-driven prompts. The catastrophic floor, the backstop set, risky
integrations, a paused session, and prompts the client classifies as
destructive never offer or honour one.

Choosing `never` grants any connected client unattended code execution on the
node. On a non-intercepted runtime that is bounded only by the runtime's own
sandbox and OS permissions. That is a real decision—make it deliberately.

## Sandboxing

There is **no Bivy-owned OS jail**. Bivy does not implement seccomp, namespaces,
Seatbelt, or a container boundary of its own. Understanding what you actually
get requires splitting agents into two groups (`src/harness/sandbox.ts`).

Bivy exposes one policy knob with three tiers, borrowing Codex's vocabulary:

| Tier | Intent |
| --- | --- |
| `read-only` | May read the workspace. No writes, no network. |
| `workspace-write` (default) | May read/write the worktree; escapes need approval. |
| `danger-full-access` | No in-agent limit, no Bivy approval prompts, no workspace boundary. Explicit opt-out. Only the catastrophic-command floor still applies on intercepted tool paths. |

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

## Known limitations for 0.x

Bivy is early 0.x software. Know these before trusting it with anything
sensitive.

1. **No Bivy-owned OS sandbox.** As above: agents without a native sandbox run
   as your user with your permissions. Bivy's governance is effect-level and
   partial. Do not treat Bivy as an isolation boundary.
2. **The hard-floor deny list is heuristic.** Regex over a shell command string.
   It stops accidents, not a determined agent.
3. **Loopback is trusted by default on hosts we believe are single-user.** On a
   host `isMultiUserHost()` (`src/auth.ts`) recognizes as shared, token auth is
   required automatically and any process on the machine — any user — can
   otherwise only reach the token-minting endpoint, which is itself gated by
   the bootstrap secret. Detection is heuristic (`/etc/passwd` on Linux, `dscl`
   on macOS, not implemented on Windows) and errs toward *not* flagging a host
   as shared, so it can be wrong in either direction. If in doubt, set
   `BIVY_REQUIRE_LOCAL_AUTH=1` explicitly rather than relying on detection.
4. **`BIVY_ALLOW_ANY_ORIGIN=1` fully disables the rebinding/cross-origin
   guard.** It exists as an escape hatch; using it re-opens the attack the guard
   was written to close.
5. **Run evidence is metadata-only by design, not an audited compliance
   artifact.** The sanitizer (`services/control-plane/src/run-evidence.ts`)
   allowlists and bounds every field, but it is a code-level guard, not a
   third-party certification — see
   [Run evidence and outcome reports](automation-runs.md#run-evidence-and-outcome-reports).
6. **The local vault's wrapping key sits next to the vault.**
   `.bivy/secrets.key` and `.bivy/secrets.json` are both on the same disk at
   mode `0600`. This protects against other local users, not against someone who
   can read your home directory or your backups. Use the 1Password or env
   reference backends if you need better.
7. **No OS keychain integration yet.** Related to the above; node-held secrets
   are file-based.
8. **No recovery story for the model-auth vault.** If you lose every node and
   device that can unwrap it, the ciphertext on the control plane is
   unrecoverable by design. There is no escrow of the account vault (the
   separate, opt-in hosted-custody set in item 16 is the only exception).
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
13. **No third-party security audit.** Bivy has not been externally audited.
14. **Approvals expire denied after 5 minutes.** A long-running unattended
    session that hits an approval will stall and then fail rather than proceed.
15. **Account pairing trusts the control plane to authorize devices.** When a
    signed-in browser links a node from the app (rather than by QR /
    `bivy link`), the node wraps the room key for **any** device public key the
    control plane says yes to (`POST /node/authorize-client`,
    `authorizeAccountPairing` in `src/remote/relay-client.ts`), and the browser
    takes the node's public key on trust from the first pairing frame it sees
    over the relay (`handlePairFrame`, `packages/core/src/transport-relay.ts`).
    The relay still cannot read anything, but a compromised or malicious
    control plane could authorize a device it controls, or — colluding with the
    relay — substitute keys during the handshake. QR / `bivy link` pairing does
    not depend on the control plane for that decision, and self-hosting the
    control plane puts the decision under your own control. See
    [Account pairing](#account-pairing-the-control-plane-vouches-for-the-device).
16. **Hosted ephemeral provisioning is an explicit hosted-custody mode.** When
    the control plane launches an ephemeral machine on your behalf, it
    generates the machine's room key and **escrows it** (encrypted at rest,
    `setNodeRoomKeyEnc`, `services/control-plane/src/ephemeral-provisioner.ts`)
    so it can reach the machine again later; the same mode may hold a filtered
    set of credentials you have explicitly granted for unattended runs. For
    those machines the control plane can decrypt session traffic — this is a
    deliberate trade of end-to-end privacy for device-offline provisioning,
    off by default and opt-in per account. Device-driven ephemeral launches
    (the browser mints the room key and bakes it into the machine) keep the
    control plane blind. See
    [`hosted-provisioning-trust-model.md`](hosted-provisioning-trust-model.md),
    [`key-management.md`](key-management.md), and
    [`ephemeral-sessions.md`](ephemeral-sessions.md).
17. **The web app that holds your room key is delivered by the control plane.**
    Browser-side crypto is only as trustworthy as the JavaScript that runs it,
    and the PWA is served by the control plane (hosted `app.bivy.sh`, or your
    own). A compromised control plane could ship modified JS that exfiltrates
    the room key or plaintext from the browser; the relay's blindness does not
    help there. This is inherent to any web-delivered end-to-end encryption.
    Mitigations: self-host the control plane so you control what is served,
    or use the terminal CLI on the node (`bivy run`, `bivy attach`), which
    involves no control plane at all.

## Reporting

Security issues go through GitHub private vulnerability reporting. See
[`../SECURITY.md`](../SECURITY.md) for the process, scope, and safe harbour.
