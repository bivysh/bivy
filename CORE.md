# Bivy Core

Bivy Core is free and open-source software licensed under the GNU Affero General
Public License, version 3.0 only (AGPL-3.0-only). You may use, study, modify, and
self-host it under the terms of that license. If you modify Bivy and let users
interact with it over a network, you must offer those users the corresponding
source code as required by section 13 of the license.

Core includes:

- the local node daemon and CLI;
- the agent-agnostic runtime layer and local session management: the daemon drives every agent through one runtime interface, with Pi as the first adapter among equals (Claude Code, Codex, and the rest), not privileged core code;
- shared PWA protocol and client assets (the browser UI is served by the control plane);
- terminal mode and approval/guardrail logic;
- E2E relay protocol and pairing primitives;
- self-hostable relay and control-plane services (self-hosting is unsupported, no SLA — you own operations; see `docs/self-host.md`);
- bring-your-own-cloud ephemeral runner orchestration primitives;
- documentation and tests needed to run, modify, and self-host Bivy.

Core does not contain Bivy Cloud billing, plan definitions, commercial usage
metering, upgrade UI, or entitlement rules. Those live exclusively in the
separate Cloud repository. Operators may configure the neutral deployment-
extension contract; without one, Core imposes no commercial limits.

Core promises:

- Bivy requires relay/control-plane enrollment to deliver its core value — remotely visible, steerable sessions — but that enrollment can always target self-hosted infrastructure, so a Bivy Cloud account is never mandatory;
- users bring their own model/provider credentials for launch; Bivy Cloud is not required for AI inference;
- sensitive workspace data stays on the node unless the user explicitly opts into a feature that moves it;
- Bivy Cloud endpoints are defaults, not lock-in — equivalent self-host URLs can be configured.

See `CLOUD.md` for the paid hosted service and repository boundary.
