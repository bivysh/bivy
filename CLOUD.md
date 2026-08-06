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

Cloud must not require uploading workspace files, interactive session transcripts or prompts, tool output, plaintext model credentials, GitHub repo tokens, or local secrets to the control plane. The node remains the data plane; Cloud coordinates metadata and routing. Explicit inbound-automation features are the documented exception: Slack commands and generic webhook instructions are sent to the control plane by their source and retained with the queued item; GitHub and Linear issue text is fetched directly by the node.

Paid entitlement checks belong in hosted/account features. They must not prevent self-hosted Core deployments from operating.

Repository boundary: Bivy Core, plus the baseline self-hostable relay and control plane, are open-source under AGPL-3.0-only in this repository. Bivy-operated production infrastructure, secrets, support tooling, private commercial overlays, and any managed compute/inference service live in a separate private Cloud repository.

## Ephemeral runner lifecycle: two lanes, one control plane

Bivy Cloud is a **neutral control plane over many compute substrates**, not a compute/inference provider itself (see above). The user chooses *where* an ephemeral runner runs; Bivy makes the substrates look the same to the session layer. Those substrates fall into two lanes that differ in **who owns machine lifecycle** — i.e. who suspends or destroys an idle/finished machine:

- **Managed-sandbox lane (buy).** The substrate is itself a managed sandbox platform that owns the fleet and enforces lifecycle centrally — Fly Sprites (suspend-to-idle) and E2B (`onTimeout: pause|kill`). Suspend/destroy is the *platform's* job, enforced server-side with no Bivy device or node online. Bivy only creates and wakes.
- **Bring-your-own-cloud lane (self-host).** The substrate is a raw VM on the user's own account — Fly Machines, Hetzner, EC2. There is no external authority to enforce lifecycle, so Bivy must. Today teardown-on-agent-finish is *device-driven* (the launching browser issues the destroy on `agent_end`); the machine's TTL self-shutdown is the only server-side backstop. This is why the launch UI warns that "destroy when the agent finishes" **requires this device to stay online** — accurate today, and the thing this design removes.

The BYO lane now has the managed lane's "walk away and it cleans itself up" guarantee, without weakening the control plane's no-secrets posture — **implemented** for Fly/EC2 and hosted Hetzner (see `docs/ephemeral-sessions.md` → "Server-side teardown"):

1. The teardown *decision* lives in the daemon: a destroy-lane machine is tagged `BIVY_EPHEMERAL=1` at boot and self-terminates once quiet (no running turn, no attached device, no in-flight queue work, past a grace) — `shouldSelfTeardown` in `src/ephemeral-teardown.ts`. The launching device no longer needs to be online.
2. Providers that self-reap on process exit (Fly `auto_destroy`, EC2 shutdown-terminate) need **no stored credential** — the daemon just exits/halts.
3. Hetzner doesn't self-reap on OS shutdown, so the daemon posts a **non-secret** `POST /node/settled` and the control plane issues the provider `DELETE` using the `hosted.providerTokens` it already holds for hosted accounts; `reconcileHostedMachines` is the backstop. Device-launched Hetzner (no server-side token) stays device/TTL-bound — a documented limitation; steer zero-teardown users toward the managed lane or a scoped/opt-in server credential.

Credential posture is unchanged by default: provider tokens stay device-local, the control-plane exec relay stays a non-storing host-allowlisted forwarder, and `/node/settled` carries only a node id. The only server-side teardown credential is the `hosted.providerTokens` the CP already holds for opt-in hosted-provisioning accounts.

**Caveat — the managed lane's guarantee is provider-specific.** E2B's pause is *deterministic* (a server-enforced timeout), so it holds regardless of what the daemon's relay connection is doing. Fly Sprites' suspend is *idle-triggered* by an external heuristic Bivy does not control; the daemon keeps a persistent outbound relay WebSocket (30s pings) with no quiet-mode, so whether a Sprite actually suspends while the daemon runs is unverified — it likely depends on inbound-request idleness, not outbound traffic, but must be confirmed against a live Sprite. Until then, treat Sprites' "~$0 when idle" as unproven and prefer E2B where deterministic suspend matters.
