# Releasing and distribution

The Bivy node and CLI are distributed on npm as the
[`@bivy/bivy`](https://www.npmjs.com/package/@bivy/bivy) package. `install.sh`
is a thin bootstrapper: it ensures a supported Node.js is present, runs
`npm install -g @bivy/bivy`, and then runs `bivy setup`.

The control plane and relay are distributed as public GHCR images built by
`service-images.yml` from their source commit. Every Core commit on `main`
receives an immutable full-SHA tag. Production promotion aliases those existing
manifests to `X.Y.Z`, `vX.Y.Z`, and `latest` without rebuilding them. Cloud deployment may
add deployment-specific metadata around these images, but does not rebuild Core.

npm is the node/CLI distribution channel. `install.sh` retains a checksum-verified
tarball fallback (`TARBALL_URL`/`MANIFEST_URL`/`install_from_tarball`) used only
during the cutover — when the `bivy` package isn't yet on the registry.

## Release channels

Bivy ships on two npm [dist-tags](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag),
both published from CI via the single `release.yml` workflow:

| Channel | dist-tag | Version shape | When it publishes | Install |
|---|---|---|---|---|
| **Production** | `latest` | `X.Y.Z` | on a deliberate "Promote" dispatch | `npm i -g @bivy/bivy` (default) |
| **Staging** | `staging` | `X.Y.Z-staging.N` | automatically on every merge to `main` | `BIVY_CHANNEL=staging` / `npm i -g @bivy/bivy@staging` |

The flow is trunk-based: every change lands on `main` through a PR, and each merge
immediately publishes a unique, provenance-signed **staging** build that the dev
fleet can install with `BIVY_CHANNEL=staging`. `latest` never moves on a merge —
it only advances when a maintainer promotes the current `package.json` version to
production (see "Cutting a production release"). Staging versions are semver
prereleases, so they sort *below* `X.Y.Z` and never satisfy a plain `@bivy/bivy`
install; they also never consume the eventual stable `X.Y.Z` version.

`package.json` on `main` always holds the **next** clean release version
(`X.Y.Z`, no prerelease suffix). Staging builds derive from it (`X.Y.Z-staging.N`);
promoting publishes exactly that `X.Y.Z`. After a production release, bump
`package.json` to the next target in a PR so subsequent staging builds carry the
new number.

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
npm view @bivy/bivy@0.1.0 dist.integrity
npm view @bivy/bivy@0.1.0 dist.attestations
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

Configure it once, on the `@bivy/bivy` package's **Settings → Trusted Publishers**
page on npmjs.com (requires the package to already exist — see
"Bootstrapping" below):

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `bivysh` |
| Repository | `bivy` |
| Workflow filename | `release.yml` |
| Environment name | **(leave blank)** |
| Allowed actions | `npm publish` |

**Leave the Environment field blank.** One workflow file (`release.yml`) is the
single trusted publisher npm permits per package, and it publishes *both*
channels. The automatic **staging** job runs in no GitHub environment, so pinning
an environment in npm's trust policy would reject every staging publish. The
**production** job still self-gates on the `release` GitHub environment for
approval — that is a GitHub-side control and does not need to be (and must not be)
part of npm's trust policy.

Create the GitHub `release` environment and require a maintainer review under
**Settings → Environments → release**. This gates only the production/promote
path; staging is unaffected.

npm's CLI needs to be `>= 11.5.1` to speak the trusted-publishing protocol;
`release.yml` upgrades it explicitly (`npm install -g npm@^11`) rather than
bumping the repo's pinned Node version just for that.

### Bootstrapping

The `@bivy/bivy` package already exists as a placeholder, so no manual bootstrap
publish is needed. Configure the trusted publisher above; the first merge to
`main` then publishes a `staging` build with provenance, which is the fastest way
to confirm the whole OIDC path works end to end. Do not publish from a laptop;
npm versions are immutable and a hand publish carries no provenance.

## Staging (automatic)

Nothing to do. Every merge to `main` runs the `staging` job in `release.yml`,
which stamps the next `X.Y.Z-staging.N` for the current clean base version onto
the package, publishes it to the `staging` dist-tag with provenance, and moves
on. The staging counter resets for each new base (for example,
`0.15.0-staging.1`). There is no tag, no changelog
requirement, and no approval — it is meant to be invisible. Install/verify a
staging build with:

```bash
BIVY_CHANNEL=staging curl -fsSL https://bivy.sh/install.sh | sh
# or, directly:
npm install -g @bivy/bivy@staging
npm view @bivy/bivy dist-tags        # see what `staging` and `latest` point at
```

## Cutting a production release

Production is a deliberate promotion of whatever version `package.json` currently
holds on `main`, to the `latest` dist-tag.

1. Open a PR that, on `main`:
   - runs `pnpm run release:version -- X.Y.Z` to set the root, package, and
     service manifests together to a clean release version;
   - moves `CHANGELOG.md`'s `[Unreleased]` into a `## [X.Y.Z]` section.
   Merge it and wait for its required CI and automatic staging publish to pass.
   (The staging build is a release candidate for exactly this commit.)
2. Run the **Promote** button: Actions → **Release** → *Run workflow* (from
   `main`), and type the exact `X.Y.Z` into the confirmation field. Or from the
   CLI:

   ```bash
   gh workflow run release.yml --ref main -f confirm_version=X.Y.Z
   ```
3. Approve the run when it pauses on the `release` environment.

Before publishing, promotion creates the durable tag
`release-intent-vX.Y.Z`, binding that version to the exact commit. The tag is
kept after a successful release. If a run fails after creating the intent,
resume from that ref—not from a newer `main`:

```bash
gh workflow run release.yml --ref release-intent-vX.Y.Z \
  -f confirm_version=X.Y.Z
```

The workflow accepts an existing npm version only when the intent points to its
current commit and npm's `latest` tag already names that version. Image aliases,
the final `vX.Y.Z` tag, and the GitHub release are idempotent, so this recovery
cannot mix artifacts from different commits.

The release PR must pass the repository's full required CI before it can merge.
Promotion does not run that same suite a second time: it verifies that the exact
`main` commit completed its automatic staging publish, validates the version and
workspace agreement, and publishes the stable build to `latest` via Trusted
Publishing (automatic provenance). It then tags the commit `vX.Y.Z` and creates
the GitHub release from the matching CHANGELOG section
(`scripts/extract-changelog.mjs`). If Promote is clicked while staging is still
running, it waits for up to ten minutes.

After the release, use `pnpm run release:version -- X.Y.Z` in the development
version PR as well; this replaces the previous manual edits across every
manifest.

### Publishing by hand (discouraged)

```bash
pnpm run publish:npm:dry            # inspect what would ship (dry-run, latest)
pnpm run publish:npm                # publish to `latest`
pnpm run publish:npm -- --tag staging   # publish to `staging`
```

A hand publish produces **no** provenance attestation — npm can only attest to
builds it can trace to a CI workflow — and needs a token or interactive 2FA that
the trusted-publishing workflow exists precisely to avoid. The build prints a
warning when this happens. Prefer the workflow.

## Service container images

```text
ghcr.io/bivysh/bivy-control-plane:<full-sha|version|latest>
ghcr.io/bivysh/bivy-relay:<full-sha|version|latest>
```

The full 40-character commit tag is write-once. Each tag is a multi-platform
OCI index for `linux/amd64` and `linux/arm64`. Both images carry OCI source,
revision, and AGPL license labels plus SBOM and provenance attestations.
`latest` and version tags are created only by the production release job and all
reference the exact full-SHA manifest built for
that commit. A manual `service-images.yml` dispatch with `core_ref` can backfill
an older tag or SHA.

GHCR visibility cannot be changed through the Packages REST API. Before enabling
the image workflow, use the package settings UI to make both packages **public**
and grant `bivysh/bivy` Actions **admin** access. The workflow verifies anonymous
pulls and records an exact-SHA commit status only after that check passes.

The two package names historically originated in the Cloud deployment repository.
Keep or remove that repository's access independently because it now publishes
deployment wrappers under separate `bivy-cloud-*` package names. These one-time
registry ACL and visibility changes cannot be represented in Git.

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
| `npm-global` | `npm install -g @bivy/bivy@latest`, then restart the service |
| `git` | `git pull` + `pnpm install --frozen-lockfile`, then restart |
| `packaged` | re-runs `install.sh`, which migrates the install to npm |
| `npx` | nothing to update; each run fetches afresh |

The daemon checks `https://registry.npmjs.org/%40bivy%2Fbivy/latest` every six hours and
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
