# Releasing and distribution

Bivy is distributed on npm as the [`bivy`](https://www.npmjs.com/package/bivy)
package. `install.sh` is a thin bootstrapper: it ensures a supported Node.js is
present, runs `npm install -g bivy`, and then runs `bivy setup`.

npm is the distribution channel. `install.sh` retains a checksum-verified
tarball fallback (`TARBALL_URL`/`MANIFEST_URL`/`install_from_tarball`) used only
during the cutover — when the `bivy` package isn't yet on the registry.

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
  recording the workflow, repository, and commit that built them;
- publishing itself is authenticated via **Trusted Publishing** (OIDC) rather
  than a long-lived npm access token, so there is no npm credential of any
  kind to leak, rotate, or guard either. See "Trusted publishing" below.

So the key we would otherwise have to guard forever is replaced by Sigstore's
short-lived, transparency-logged certificates, and by npm's own OIDC-based
publish authentication.

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

## Trusted publishing

`.github/workflows/release.yml` needs **no `NPM_TOKEN` secret**. It publishes
via npm's [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/):
the job's GitHub Actions OIDC identity (`permissions: id-token: write`) is
exchanged directly with the registry for a short-lived publish credential,
scoped to exactly this repository and workflow file — nothing else can
authenticate as this release path, and there is no standing token to leak,
rotate, or revoke. Provenance is generated automatically as part of the same
exchange.

Configure it once, on the `bivy` package's **Settings → Trusted Publishers**
page on npmjs.com (requires the package to already exist — see
"Bootstrapping" below):

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `bivysh` |
| Repository | `bivy` |
| Workflow filename | `release.yml` |
| Environment name | `release` |

Create the GitHub `release` environment first and require a maintainer review
under **Settings → Environments → release**. The environment is part of npm's
OIDC trust policy, so the value above must match exactly.

npm's CLI needs to be `>= 11.5.1` to speak the trusted-publishing protocol;
`release.yml` upgrades it explicitly (`npm install -g npm@^11`) rather than
bumping the repo's pinned Node version just for that.

### Bootstrapping

npm can only configure a trusted publisher for a package that **already
exists** — there's no equivalent of "reserve this name for CI" for a brand
new package. The first publish therefore happens once by hand with a maintainer's
npm login (or a short-lived classic Automation token), before the table above
can be filled in.

Bootstrap with a disposable prerelease version — **not** the final release
version. Publishing `0.1.0` manually and then pushing `v0.1.0` would make the tag
workflow fail because npm versions are immutable.

```bash
# In a clean, disposable checkout; do not commit this temporary version.
npm pkg set version=0.1.0-bootstrap.0
npm run publish:npm:dry
npm login
npm run publish:npm       # bootstrap only; no provenance is expected
```

Delete/reset that checkout, configure the trusted publisher above, and cut the
real `v0.1.0` from the normal tree. The tag workflow then publishes `0.1.0` once,
with provenance. Every later tagged release follows the same CI path.

## Cutting a release

1. Land everything on `main` and make sure CI is green.
2. Bump the version manually in the root `package.json` and in every workspace
   `package.json` (`packages/*`, `services/*`) so they all agree — there is no
   sync script.
3. Update `CHANGELOG.md` — move `[Unreleased]` into a dated section.
4. Tag: `git tag -a v0.1.0 -m "Bivy 0.1.0" && git push origin v0.1.0`.
5. The tag-triggered release workflow (`.github/workflows/release.yml`) checks
   out the tag, runs the full CI gate (`.github/workflows/ci.yml`, reused via
   `workflow_call`), publishes to npm via Trusted Publishing (with automatic
   provenance), and creates the GitHub release from the matching
   `## [x.y.z]` section of `CHANGELOG.md` (`scripts/extract-changelog.mjs`).

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
