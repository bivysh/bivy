# Portable self-hosting implementation plan

## Final direction

The deployment contract is **two public images + Postgres + environment
variables**, not a provider template or deployment engine. No Render/DigitalOcean
specs are required. The control-plane image includes the PWA. Platforms supply
HTTPS and container lifecycle; the existing Compose/Caddy installer remains an
optional convenience for a bare VPS. Kamal remains compatible with the same
images/configuration but is not required for users.

## Work

1. Document the portable image, environment, networking, health, persistence,
   upgrade and backup contract in `docs/deploy-images.md`. Provide separate
   generic control-plane and relay environment examples.
2. Implement opt-in browser owner setup with `SELF_HOST_SETUP_TOKEN`. A private,
   operator-generated token proves deployment control; there is no public
   first-visitor-wins claim. No SSH or external identity provider is required.
3. Persist a salted scrypt password and spent setup-token hashes in Postgres.
   Password sign-in works after removing the bootstrap environment variable.
   Recovery uses a new token from deployment settings, preserves the account,
   and revokes account sessions. Old tokens remain spent across restarts,
   rotations and account deletion. Fence login against concurrent resets.
4. Expose configured sign-in methods to the PWA. Reuse existing form, error,
   loading and button components; owner setup/login completes in-place in an
   installed PWA. Cover unavailable server, invalid token/password, mismatches,
   busy state, recovery and no configured sign-in provider.
5. Retain the VPS convenience work: checksummed release bundles, optional Docker
   installation, single-domain relay routing, generated secrets/push keys,
   readiness checks, shell login and backup/update commands. These consume the
   same images rather than define a different product.
6. Verify auth/storage and bootstrap tests, PWA owner/machine onboarding in
   desktop/mobile + light/dark, types/lint/design/architecture checks, and the
   production-image smoke gate before publication.

## Security and boundaries

- Deployment secrets go in runtime secret storage, never images, URLs, frontend
  variables, or git. Passwords are hashed with fixed scrypt parameters. Bound
  expensive hashing concurrency and share rate limits in Postgres.
- The owner is an ordinary local Bivy account, not a cross-account administrator
  and not proof of external email ownership. Model/repo credentials remain on
  Machines unless explicitly entrusted to supported encrypted storage.
- Recovery revokes account sessions, not enrollment tokens or device pairing
  keys. Existing Machines/devices need separate review after compromise.
- A database restore restores historical auth state too. Rotate deployment
  secrets and review access after a restore; image rollback is not DB rollback.
- No Cloud configuration or running services were changed. Cloud-specific
  billing, vaults, image wrappers and migration/reset operations stay private.

## Verification and remaining release work

Passed the Compose/bootstrap, bundle, install-command, shell-login, store-contract,
store-boundary, sign-in-funnel and portable owner-auth tests. The owner tests cover
setup proof, hashing, password recovery, spent-token replay, account deletion,
session fencing, origin/content-type checks and shared throttling.

Passed all eight real-PWA owner/machine onboarding tests across desktop/mobile
and light/dark, plus existing first-run/OAuth browser checks. Inspected screenshots
and refined form density, labels, focus and touch targets. Browser tests use
HTTP/clipboard fixtures, not a duplicated HTML screen or a real provider.

Root/control-plane/web types, the production PWA build, design-token guard,
architecture/route guards, link checks and targeted lint pass. Repository-wide
lint has no errors but retains its existing warnings.

Docker is unavailable in the implementation environment. The published-image
smoke (`scripts/smoke-self-host.sh`) must run in CI; it now covers browser owner
setup/sign-in as well as shell login, PWA serving, enrollment and relay handshake.
Real DNS/ACME, platform WebSocket behavior, database backup restoration and the
first real agent response still need a deployment acceptance test. New image
features and release-bundle download URLs are available only after publication.
