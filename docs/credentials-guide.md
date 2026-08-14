# How credentials work in Bivy

A practical guide to model-provider credentials: multiple keys and accounts per
provider, password-manager references, per-credential sync, and how a project
picks which key to use.

Companion docs: [key-management.md](key-management.md) (where every secret lives),
[credential-sync.md](credential-sync.md) (the four sync classes), and the design
notes in [credentials-service-plan.md](credentials-service-plan.md).

---

## The mental model

Every model credential is a **record** with a natural identity: **`provider:label`**.

- **provider** — `anthropic`, `openai`, `xai`, `openai-codex`, …
- **label** — `default`, `work`, `personal`, `project-acme`, … (you choose these)

So `anthropic:default` and `anthropic:work` are two separate credentials for the
same provider. If you only ever have one key per provider it's just
`provider:default`, and you never see labels — **the multi-account machinery is
invisible until you want it.**

Each record has:

| Field | Meaning |
| --- | --- |
| **source** | Where the secret lives: **stored** (a key / OAuth token in Bivy's encrypted vault) or **reference** (a pointer like `op://…` / `env://NAME`, resolved on the machine — the secret never enters Bivy). |
| **sync** | `account` (syncs to your other nodes, end-to-end encrypted) or `node` (stays on this machine). |
| **origin** | `bivy` (you added it) or `agent-native` (captured from an agent's own login). |

---

## The three ways a credential gets in

1. **You add it** (Bivy-first) — `bivy login`, or the PWA's **Keys & OAuth**
   screen. Paste an API key, sign in via OAuth, or add a **password-manager
   reference** (`op://…` / `env://NAME`). Defaults to `sync: account`.
2. **An agent's own login** (agent-native) — you ran `codex login`,
   `claude /login`, `grok login`, or logged into Pi's TUI. Bivy captures it the
   next time you run that agent through it. You choose what happens — see
   [Ingest policy](#agent-native-logins-merge-vs-separate). Defaults to `sync: node`.
3. **A synced peer** — another of your nodes pushed it (when `sync: account`).

---

## Choosing which key gets used

When a session needs a provider (say `anthropic`), selection runs a simple ladder
and records **why** it chose — it never silently guesses between two accounts:

1. an explicit label requested by the session, else
2. that project's provider assignment, else
3. the account default for the provider, else
4. the `default`-labelled credential, else the provider's only one, else
5. nothing — if there are several accounts and no assignment, you're asked to pick.

The vault hides assignment controls until a provider has multiple credentials.
Open an item and choose **Use by default**, or select a repository under
**Assign for project**. Project rules are stored as `project:<owner/repo>` maps in
`.bivy/credentials.config.json`; the node resolves the repository from each
session workspace, so assignments apply independently without a global mode.

```jsonc
{
  "presets": {
    "default": { "anthropic": "personal" },
    "project:acme/service": { "anthropic": "work", "openai": "work" }
  }
}
```

---

## Syncing (opt-out, per credential)

- **Bivy-first credentials sync by default** across your nodes — encrypted
  end-to-end, node→node. Bivy Cloud only ever stores ciphertext; it never sees
  your keys.
- **Flip any credential to node-local** (the PWA's "This node only" toggle, or
  `sync: node`) to keep it off your other machines.
- **References sync as a pointer only** — each node resolves `op://…` against its
  own 1Password / environment, so the secret itself never travels.
- **Agent-native logins stay node-local** unless you promote them.

Non-default labels and reference pointers travel between nodes too, so a second
account you add on one machine shows up on the others (secrets end-to-end
encrypted; reference secrets stay in the manager).

---

## Agent-native logins: merge vs separate

`ingest.policy` in `credentials.config.json` decides what happens when Bivy
captures an agent's own login:

- **`merge`** (default) — folds it into that provider's `default` credential
  (the historical behavior; a native login updates the synced Bivy credential).
- **`separate`** — keeps it as its own labeled, node-local credential (e.g.
  `openai-codex:codex-<account>`), so it never overwrites a Bivy key and you can
  select it via a preset.

```jsonc
{ "ingest": { "policy": "separate" } }
```

Only agents Bivy has an adapter for are captured (Codex, Claude Code, Grok, Pi);
others (e.g. Gemini CLI) remain per-node native logins.

---

## Where things live

```
.bivy/
  credentials/
    auth.enc                 the encrypted vault (AES-256-GCM) — all your records
    auth.key                 the local 0600 encryption key
  credentials.config.json    presets + ingest policy (non-secret, safe to read)
```

---

## Common tasks

- **Add a second account:** PWA → Keys & OAuth → open the provider →
  **Additional accounts** → give it a label (e.g. `work`) and paste a key or an
  `op://…` / `env://NAME` reference.
- **Use a password-manager key:** add it as a **reference** instead of pasting
  the secret — Bivy stores only the pointer and resolves it on each node.
- **Point a project at a specific key:** open the credential in the vault, choose
  the repository under **Assign for project**, then select **Use for …**.
- **Keep a key on one machine:** set **Available on** to “Only this machine”.
- **Allow unattended runs:** explicitly enable it on that credential. Bivy writes
  a separately encrypted hosted snapshot containing only granted credentials;
  account sync alone never grants hosted custody.
- **Rotate a key:** re-save it at the same label. OAuth refresh happens
  automatically and touches only that specific account.

---

## The guarantees

- Secrets are encrypted at rest and, when synced, encrypted end-to-end between
  your nodes — the control plane only stores ciphertext.
- Password-manager secrets never enter Bivy's vault at all — only the pointer.
- One login is reused across every agent (Claude Code, Codex, Pi, …). The
  credential service is agent-independent; agents just receive the resolved key.
- The single-credential experience is unchanged: one key per provider means no
  labels, no presets, nothing new to learn.
