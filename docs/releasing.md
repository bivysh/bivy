# Releasing and distribution

Bivy is distributed on npm as the [`bivy`](https://www.npmjs.com/package/bivy)
package. `install.sh` is a thin bootstrapper: it ensures a supported Node.js is
present, runs `npm install -g bivy`, and then runs `bivy setup`.

There is no self-hosted release tarball and no release manifest.

## Why npm rather than a signed tarball

Earlier builds published a `.tar.gz` plus a JSON manifest carrying a SHA-256
digest and an Ed25519 signature, which `install.sh` verified before installing.
That worked, but it meant holding a release private key indefinitely. Anyone who
obtained it could ship a "valid" Bivy to every user, and rotating it required
shipping an installer that trusted both keys through a cutover window.

npm provides the same guarantees without that liability:

- the registry serves content-addressed tarballs and npm verifies each package's
  integrity hash on install;
- packages published from CI with `--provenance` carry a signed attestation,
  recording the workflow, repository, and commit that built them.

So the key we would otherwise have to guard forever is replaced by Sigstore's
short-lived, transparency-logged certificates.

## Verifying a release

```bash
# Attestations for the installed dependency tree.
npm audit signatures

# What the registry says about a specific version.
npm view bivy@0.1.0 dist.integrity
npm view bivy@0.1.0 dist.attestations
```

The provenance attestation is also shown on the package page under
"Provenance", linking back to the exact workflow run and commit.

## Required secrets

`.github/workflows/release.yml` runs on every `v*` tag push, and needs one
repository secret to publish:

| Secret | Used for |
|---|---|
| `NPM_TOKEN` | An npm access token (Automation or Publish permission) for the `bivy` package, used by `npm publish` inside `scripts/build-release.mjs`. |

Add it under **Settings → Secrets and variables → Actions → New repository
secret**. If it's missing, the workflow fails fast with a clear error instead
of publishing an unattested package — `npm publish --provenance` can only
succeed when it's run from CI with a valid registry token, and this repo would
rather fail the release than ship one without the attestation described above.

## Cutting a release

1. Land everything on `main` and make sure CI is green.
2. Bump the version (all workspaces must agree; see `scripts/sync-version.mjs`).
3. Update `CHANGELOG.md` — move `[Unreleased]` into a dated section.
4. Tag: `git tag -a v0.1.0 -m "Bivy 0.1.0" && git push origin v0.1.0`.
5. The tag-triggered release workflow (`.github/workflows/release.yml`) checks
   out the tag, runs the full CI gate (`.github/workflows/ci.yml`, reused via
   `workflow_call`), publishes to npm with provenance (`id-token: write` lets
   `scripts/build-release.mjs` pass `--provenance`), and creates the GitHub
   release from the matching `## [x.y.z]` section of `CHANGELOG.md`
   (`scripts/extract-changelog.mjs`).

To publish by hand:

```bash
npm run publish:npm:dry   # inspect what would ship
npm run publish:npm
```

Publishing by hand produces **no** provenance attestation — npm can only attest
to builds it can trace to a CI workflow. The build prints a warning when this
happens. Prefer the workflow.

## What ships in the package

`scripts/build-release.mjs` stages a curated directory rather than publishing the
repository. It contains:

```text
bin/            the bivy CLI
dist/           compiled server, runtime adapters, CLI helpers
public/qr.js    QR rendering for `bivy link` and setup
package.json    with dev-only scripts, workspaces, and mobile deps removed
README.md
LICENSE
```

It deliberately excludes `src/`, `services/`, `deploy/`, `test/`, `docs/`, and
the web client — the PWA is built and served by the control plane, not the node.

Never run `npm publish` from the repository root. The staging directory exists
precisely to avoid shipping the whole monorepo and to sidestep the `prepare`
script, which fails in a packaged install.

## How users update

`bivy update` detects how Bivy was installed and does the right thing:

| Install kind | Update action |
|---|---|
| `npm-global` | `npm install -g bivy@latest`, then restart the service |
| `git` | `git pull` + `npm ci`, then restart |
| `packaged` | re-runs `install.sh`, which migrates the install to npm |
| `npx` | nothing to update; each run fetches afresh |

The daemon checks `https://registry.npmjs.org/bivy/latest` every six hours and
posts an in-session notice when a newer version exists. Override the endpoint
with `BIVY_UPDATE_REGISTRY_URL` to point at a mirror or private registry.

## Migrating from the tarball installer

Installs created by the previous installer keep their state *inside* the app
directory, at `~/.bivy/app/.bivy`. A global npm package directory is replaced on
every update, so state now lives at `~/.bivy`.

`install.sh` performs this migration once, and only when the destination has no
`cli.json` — so it can never overwrite newer state. The old tree is left in place
so you can roll back; remove it once you're satisfied:

```bash
rm -rf ~/.bivy/app
```

Covered by `test/installer-migration.sh`.
