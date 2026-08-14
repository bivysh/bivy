# @bivy/automation-core

Shared automation preflight and simulation evaluator: first-match rule
evaluation, overlap/shadow detection, and the preflight checklist used by
config-as-code validation/test, the control-plane API, and the PWA.

Canonical source lives in [`src/automation`](../../src/automation) at the
repository root, not in this package. This package exists only to republish
that source as an installable dependency for `services/control-plane` (a
separate npm-managed service, not a pnpm workspace member — see its own
`package-lock.json`) and for `packages/web`.

The root CLI/daemon package (`@bivy/bivy`) imports `src/automation` directly
via a relative path instead of depending on this package, the same way it
already does for `src/plugin-sdk` / `@bivy/plugin-sdk`. It deliberately does
not depend on `packages/*` npm packages (see the note in
`src/session/inline-image-fetch.ts` about `@bivy/core`), so mirroring the
plugin-sdk split — canonical source under `src/`, a thin `packages/*` build
wrapper for everyone else — keeps that boundary intact while still giving
control-plane and web a single real dependency instead of a second
hand-maintained copy.

See `docs/automation-evaluator.md` for the design.
