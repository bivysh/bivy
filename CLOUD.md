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

Repository split guidance: keep Bivy Core plus the baseline self-hostable relay/control-plane source-available under FSL-1.1-ALv2; keep Bivy-operated production infrastructure, secrets, support tooling, private commercial overlays, and any future managed compute/inference service in a separate private Cloud repository. See `docs/repo-split-plan.md`.
