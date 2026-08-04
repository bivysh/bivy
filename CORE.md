# Bivy Core

Bivy Core is the source-available, self-hostable part of Bivy, licensed under the
Functional Source License (FSL-1.1-ALv2): free to use, modify, and self-host for
any purpose except a Competing Use, converting to Apache-2.0 two years after each
release.

Core includes:

- the local node daemon and CLI;
- the agent-agnostic runtime layer and local session management: the daemon drives every agent through one runtime interface, with Pi as the first adapter among equals (Claude Code, Codex, and the rest), not privileged core code;
- local browser UI and shared PWA assets;
- terminal mode and approval/guardrail logic;
- E2E relay protocol and pairing primitives;
- self-hostable relay and control-plane services (self-hosting is unsupported, no SLA — you own operations; see `docs/self-host.md`);
- bring-your-own-cloud ephemeral runner orchestration primitives;
- documentation and tests needed to run, modify, and self-host Bivy.

Core promises:

- Bivy requires relay/control-plane enrollment to deliver its core value — remotely visible, steerable sessions — but that enrollment can always target self-hosted infrastructure, so a Bivy Cloud account is never mandatory;
- users bring their own model/provider credentials for launch; Bivy Cloud is not required for AI inference;
- sensitive workspace data stays on the node unless the user explicitly opts into a feature that moves it;
- Bivy Cloud endpoints are defaults, not lock-in — equivalent self-host URLs can be configured.

See `CLOUD.md` for the paid hosted service and repository boundary.
