# Bivy Cloud

Bivy Cloud is the paid hosted convenience layer for Bivy Core.

For launch, Bivy Cloud is **not** a hosted AI inference/model product. Users still run agents on their own computers with their own model API keys or provider OAuth/subscription credentials. Cloud may store only E2E-encrypted credential-sync ciphertext that it cannot decrypt.

Ephemeral machines, where enabled, are **bring-your-own-cloud** at launch: the user supplies a scoped Fly.io/Hetzner token from their own account and pays that provider directly. Bivy Cloud may provide the hosted control-plane/proxy path needed to create a short-lived runner from a browser, but it must not store the provider token or become the compute/inference provider.

Cloud may provide:

- managed relay and control-plane uptime;
- hosted remote web/PWA access;
- account, device, and node registry;
- cross-device session metadata index;
- GitHub/Slack/webhook capture and routing;
- push notifications;
- bring-your-own-cloud ephemeral runner orchestration;
- billing, plan limits, team/org administration, and audit features;
- managed TLS, backups, monitoring, abuse prevention, and support.

Cloud must not require uploading workspace files, transcripts, prompts, tool output, plaintext model credentials, GitHub repo tokens, or local secrets to the control plane. The node remains the data plane; Cloud coordinates metadata and routing.

Paid entitlement checks belong in hosted/account features. They must not prevent local-only Core usage or self-hosted deployments from operating.

Repository boundary: Bivy Core, plus the baseline self-hostable relay and control plane, are source-available under FSL-1.1-ALv2 in this repository. Bivy-operated production infrastructure, secrets, support tooling, private commercial overlays, and any managed compute/inference service live in a separate private Cloud repository.

## Ephemeral runner lifecycle: two lanes, one control plane

Bivy Cloud is a **neutral control plane over many compute substrates**, not a compute/inference provider itself (see above). The user chooses *where* an ephemeral runner runs; Bivy makes the substrates look the same to the session layer. Those substrates fall into two lanes that differ in **who owns machine lifecycle** — i.e. who suspends or destroys an idle/finished machine:

- **Managed-sandbox lane (buy).** The substrate is itself a managed sandbox platform that owns the fleet and enforces lifecycle centrally — Fly Sprites (suspend-to-idle) and E2B (`onTimeout: pause|kill`). Suspend/destroy is the *platform's* job, enforced server-side with no Bivy device or node online. Bivy only creates and wakes.
- **Bring-your-own-cloud lane (self-host).** The substrate is a raw VM on the user's own account — Fly Machines, Hetzner, EC2. There is no external authority to enforce lifecycle, so Bivy must. Today teardown-on-agent-finish is *device-driven* (the launching browser issues the destroy on `agent_end`); the machine's TTL self-shutdown is the only server-side backstop. This is why the launch UI warns that "destroy when the agent finishes" **requires this device to stay online** — accurate today, and the thing this design removes.

The **direction** is to give the BYO lane the managed lane's "walk away and it cleans itself up" guarantee, without weakening the control plane's no-secrets posture:

1. Move the teardown *decision* into the daemon (it already sees `agent_end` and the follow-up queue) and emit a small **non-secret** "session finished" signal to the control plane. The launching device no longer needs to be online.
2. For providers that self-reap on process exit (Fly `auto_destroy`, EC2 shutdown-terminate), the daemon simply exits; the control plane runs a **backstop reconciler** (extends the existing `reconcileHostedMachines`) to enforce TTL and clean bookkeeping. No stored provider credential is required for these.
3. Hetzner has no per-resource-scoped token and does not self-reap on OS shutdown, so it needs an explicit provider `DELETE`. Prefer a **scoped/opt-in** credential held server-side over storing full account tokens; steer users who want zero-teardown toward the managed lane.

Credential posture is unchanged by default: provider tokens stay device-local, and the control-plane exec relay stays a non-storing, host-allowlisted forwarder. Any server-side teardown credential is opt-in and as narrowly scoped as the provider allows.

**Caveat — the managed lane's guarantee is provider-specific.** E2B's pause is *deterministic* (a server-enforced timeout), so it holds regardless of what the daemon's relay connection is doing. Fly Sprites' suspend is *idle-triggered* by an external heuristic Bivy does not control; the daemon keeps a persistent outbound relay WebSocket (30s pings) with no quiet-mode, so whether a Sprite actually suspends while the daemon runs is unverified — it likely depends on inbound-request idleness, not outbound traffic, but must be confirmed against a live Sprite. Until then, treat Sprites' "~$0 when idle" as unproven and prefer E2B where deterministic suspend matters.
