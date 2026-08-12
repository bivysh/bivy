# Bivy — the governed, agent-agnostic agent substrate you own outright

Run any AI coding agent on **your own machines**; reach and automate it from
**anywhere**; and keep a **provable record** of everything it did — with **no
lock-in, no compute markup, and every hosted piece blind or self-hostable.**

Local-first power. Remote-first convenience. Governed by you. Yours to keep.

## The problem

AI coding agents can do real work now — but today they come with a bad trade:

- **Run them locally** and you're chained to your desk: one machine, one terminal,
  babysitting the agent while it works.
- **Run them in the cloud** and you hand your code, your secrets, and your model
  keys to someone else's servers — locked into their agent, their pricing, and
  with no real record of what ran against your code.

You shouldn't have to choose between **keeping control of your code** and **using
your agents from anywhere** — nor give up **knowing and governing what the agent
actually did.**

## What bivy is

Bivy runs AI coding agents on **your own machines** and lets you reach, steer,
automate, and **govern** them from anywhere — your phone, another laptop, or on a
schedule — **without your code or secrets ever leaving hardware you own.**

It's the *substrate* agents run on, not another walled garden: bring any agent
(Claude Code, Codex, opencode, Pi, …) and any model, and get one uniform boundary
— policy, credentials, and an audit trail — across all of them.

## The three pillars

Reachability alone is now table stakes (the agent vendors ship it too). Bivy's
value is the **combination** none of them assemble:

### 1. Sovereign & no lock-in
- **Your data stays yours.** The agent runs where your code already is. Everything
  crossing the network is end-to-end encrypted; the parts we help host are *blind*
  — they route and coordinate, they never read your code or keys.
- **Your choice of agents and models.** Bring your own providers and keys; no
  privileged built-in agent.
- **You never pay us for compute.** Background/automated work runs on *your own*
  cloud account, at cost.
- **Self-host anything.** Every hosted convenience has a run-it-yourself twin — up
  to the entire stack on your own infrastructure. Even our hosted pieces are blind,
  so self-hosting isn't about privacy (you already have that) — it's **sovereignty.**

### 2. Governed & provable
This is what a careful team — and any unattended run — actually needs, and what no
agent *vendor* will build neutrally across *all* agents:
- **One boundary for every agent.** The same sandbox tier, network-egress policy,
  MCP brokerage, approvals, and credential policy apply uniformly to whatever agent
  you run — *and to whatever it spawns natively* (a native sub-agent inherits the
  boundary; it can't escape it). Bivy governs the **substrate**, not the agent's
  choices.
- **Provable, not just private.** A per-node audit trail records what each agent
  did — tool calls and their allow/deny outcome, network attempts, approvals, cost
  — attributed per session and agent, redaction-aware (decisions and metadata, never
  your payloads), queryable and exportable with `bivy audit`. *Private* control is
  table stakes; *provable* control is the difference.

### 3. Reachable & unattended
- **Reach from anywhere — no account.** Pair a machine with one QR scan and drive it
  from your phone or another laptop; your machine never gets exposed to the internet,
  only an encrypted connection rides a blind relay.
- **Agents that don't clock out.** Put an agent on a schedule or a trigger (a GitHub
  event, a webhook) and it runs *without you* — on your own cloud — so you wake up to
  finished work, and every unattended run lands in the audit trail.
- **Sign in once, use everywhere.** Model logins and API keys sync across your
  machines, end-to-end encrypted (we never see them). Keep separate work/personal
  accounts per provider and choose which one each project uses; or point at your
  password manager and the secret never enters bivy at all — you decide, per
  credential, what travels.

## How ephemeral runners fit

Ephemeral runners are the execution layer behind “agents that don't clock out,”
not a separate hosted-compute product. A trigger or schedule creates a governed
run; Bivy provisions the runner in the user's Fly, Hetzner, AWS, E2B, or Sprites
account; the normal agent-agnostic policy and audit boundary executes the work;
and the runner is destroyed or suspended when it settles. The user supplies the
provider credential and pays the provider directly. Bivy neither resells compute
nor adds a compute margin.

That makes ephemerals the point where all three pillars reinforce each other:

- **Sovereign:** the code, process, provider keys, and cloud bill remain in the
  user's account. Hosted orchestration may hold explicitly opted-in encrypted
  credentials, but it is not the compute owner.
- **Governed and provable:** unattended work gets the same sandbox, approvals,
  credential policy, and per-node audit events as an interactive run. This matters
  most when nobody is watching; a successful automation without durable evidence
  is not a trustworthy automation.
- **Reachable and unattended:** an account supplies durable fleet metadata,
  encrypted session snapshots, and optional credential escrow so a schedule can
  start—and a later message can resume—a session with no laptop or persistent node
  online. Account-free pairing remains the direct-reach entry point; unattended
  provisioning is the point where an account becomes useful rather than mandatory.

The product contract is therefore stronger than “boot a VM”: a runner must start
quickly, never leak past its TTL, persist a reconstructable session before destroy,
and make its cost and teardown status visible. Suspend-to-zero providers preserve
the runtime exactly; destroy-lane providers preserve an encrypted transcript and
git checkpoint and reconstruct the runtime on a fresh runner.

## How it works — three simple parts

Only the first ever touches your actual work:

1. **Your node — where the agent runs.** The bivy app on your machine. It runs the
   agent and holds your code, secrets, history, *and the audit trail*. This is the
   **data plane**, always yours.
2. **The relay — how you reach it.** A blind pipe carrying the encrypted connection
   between your phone and your machine. It can't read a thing — it moves sealed
   bytes.
3. **The control plane — how you manage many.** An *optional* coordinator that
   remembers your machines, syncs your view across devices, and notifies you. It
   sees *metadata only* — never content.

**The one rule that keeps you safe:** your agent, data, and audit trail live on
hardware you own; anything hosted is blind.

## Local, remote, control plane

| | **Local** | **Remote** | **Control plane** |
|---|---|---|---|
| What it is | Agent on your machine, at your desk | Reach your machines from anywhere | Your whole fleet, synced |
| Account? | No | **No** | Yes |
| What's hosted | Nothing | A blind relay | A metadata-only coordinator |

- **Local** — run agents on your own computer, drive them from your browser.
  Private, powerful, nothing to set up. *Free.*
- **Remote** — reach those same machines from your phone or another laptop, one QR
  scan each, **with no account** and nothing exposed to the internet. Pair several,
  drive them, fork sessions across them — all *without* a control plane.
- **Control plane** — the step where paired machines become a **fleet owned by your
  account**: sign in on any device and everything's there, sessions/history follow
  you, and you get push notifications when an agent needs you.

## Start where you are

Each step extends your reach and your governance. Add them only as you need them:

1. **At your desk** — run private, powerful, *governed* agents locally. *Free.*
2. **From anywhere** — steer them from your phone; your machine stays private.
   *Free, no account.*
3. **All machines as one** — sign in; fleet, history, and notifications follow you.
4. **While you're away** — agents run on a schedule or trigger, on *your own cloud*
   (your keys, your bill), each unattended run captured in the audit trail.

You never hand over your code. You never pay us for compute you didn't run on your
own infrastructure. You can prove what every agent did. And you can self-host any
part.

**Cloud-agent convenience, local-first control, and governance you can prove.**
