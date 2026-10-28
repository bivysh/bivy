# Releasing and distribution

The Bivy node and CLI are distributed as self-contained per-platform archives
on GitHub Releases (see "Self-contained archives" below). `install.sh` installs
the one for the machine and runs `bivy setup`; `bivy update` replaces it the same
way. Nothing about a release goes through npm, and running one needs no Node on
the machine.

The control plane and relay are distributed as public GHCR images built by
`service-images.yml` from their source commit. Every Core commit on `main`
receives an immutable full-SHA tag. Production promotion aliases those existing
manifests to `X.Y.Z`, `vX.Y.Z`, and `latest` without rebuilding them. A hosted
deployment may add deployment-specific metadata around these images, but does
not rebuild Core.

Stable releases also publish `bivy-self-host.tar.gz`, its `.sha256` checksum,
and the standalone `install.sh` release asset (built from **`deploy/install.sh`**,
not the root node installer). `scripts/build-self-host.mjs` uses an explicit file
allowlist and embeds the release version and exact image SHA; no `.env`, backups,
or source checkout is shipped. Older releases do not have these assets.

Before recording `service-images/published`, the image workflow runs
`scripts/smoke-self-host.sh <SHA>` against the real Compose stack. It verifies
Caddy configuration, PWA serving, durable operator login, token replay refusal,
disabled development login, node enrollment, and the relay handshake. It uses
an isolated project with disposable volumes and no public ports; real DNS/ACME
and a complete agent session still need a VPS acceptance test.

## Release channels

Bivy ships on two channels, both published by the single `release.yml` workflow:

| Channel | Where | Version shape | When it publishes | Install |
|---|---|---|---|---|
| **Production** | the `vX.Y.Z` GitHub release (`releases/latest`) | `X.Y.Z` | when `pnpm release` pushes a `vX.Y.Z` tag | `install.sh` (default) |
| **Staging** | the rolling `staging` prerelease | `X.Y.Z-staging.N` | automatically on every merge to `main` | `BIVY_CHANNEL=staging` |

The flow is trunk-based: every change lands on `main` through a PR, and each merge
immediately publishes a unique, attested **staging** build that the dev fleet can
install with `BIVY_CHANNEL=staging`. `latest` only advances when a maintainer
releases (see "Cutting a production release"). Staging versions are semver
prereleases, so they never consume a stable `X.Y.Z`.

`package.json` on `main` holds the version `main` will **release next**
(`X.Y.Z`, no prerelease suffix). Staging builds are prereleases of it
(`X.Y.Z-staging.N`), so they always sort above `latest`. A release is a `vX.Y.Z`
tag on a `main` commit: the build you tag is one the dev fleet already ran on
`staging`. `pnpm release` then opens a small follow-up PR that dates the notes
and moves `main` to the next patch. Until it merges, staging targets that next
patch on its own.

## Integrity without a release key

Earlier builds published a `.tar.gz` plus a JSON manifest carrying a SHA-256
digest and an Ed25519 signature. That meant holding a release private key
indefinitely: anyone who obtained it could ship a "valid" Bivy to every user,
and rotating it required an installer that trusted both keys through a cutover.

The archives avoid that liability:

- `install.sh` and `bivy update` check each archive against the release's
  `SHA256SUMS` / `manifest.json` before anything is replaced;
- each archive carries a GitHub build attestation (Sigstore's short-lived,
  transparency-logged certificates, issued to the workflow's OIDC identity),
  recording the workflow, repository and commit that built it;
- `bivy update` refuses an archive unless GitHub holds an attestation for its
  digest that names that file, was signed by `release.yml` in this repository
  at `refs/tags/vX.Y.Z` (or `refs/heads/main` for staging), and verifies against
  Sigstore (`bin/release-attestation.mjs`, using the Sigstore client npm ships
  in the bundled Node runtime). The installed version checks the new one, so
  a release asset swapped by someone holding a repository token is refused.
  `install.sh` does the same check with `gh attestation verify` when the GitHub
  CLI is installed and signed in. Releases from a non-GitHub mirror are checked
  by digest only; `BIVY_SKIP_ATTESTATION=1` skips the check for a fork's own
  builds;
- publishing uses the workflow's own `GITHUB_TOKEN`, so there is no release key
  or registry token to leak, rotate or guard.

## Verifying a release

```bash
gh attestation verify bivy-0.22.0-linux-x64.tar.gz --repo bivysh/bivy
sha256sum -c --ignore-missing SHA256SUMS
```

Production has no approval step: pushing the `vX.Y.Z` tag is the decision. The
`release-tags` ruleset lets only repository admins create `v*` tags and nobody
move or delete them, so a tag binds its version to one commit for good.

## Staging (automatic)

Nothing to do. Every merge to `main` runs the `staging` job in `release.yml`.
It stamps the next `X.Y.Z-staging.N` for the current clean base version,
continuing from the version the `staging` prerelease names, builds and attests
the archives, and uploads them there. Staging runs one at a time; during a burst
of merges GitHub keeps only the newest pending run, so some intermediate commits
get no staging build. The counter resets for each new base (for example,
`0.15.0-staging.1`). There is no tag, no changelog requirement, and no approval
— it is meant to be invisible. Install a staging build with:

```bash
curl -fsSL https://bivy.sh/install.sh | BIVY_CHANNEL=staging bash
```

## Cutting a production release

Add user-facing notes to `CHANGELOG.md`'s `[Unreleased]` section as changes land,
or write them to a file outside the checkout and pass it to the release. Then,
from any checkout (it is not modified):

```bash
pnpm release --dry-run                      # preview the version, commit and notes
pnpm release                                # release main's package.json version
pnpm release --notes-file /tmp/notes.md     # add these notes to the release
pnpm release minor                          # or major / X.Y.Z: retarget main first
```

That tags the current `origin/main` as `vX.Y.Z` (the version its `package.json`
names) and pushes the tag. It refuses to run with empty release notes, and
`--notes-file` notes travel in the tag message, so no commit has to land first.
`pnpm release minor|major|X.Y.Z` first lands a version-only PR retargeting `main`
(CI's light release tier), waits for the merge queue, and tags that commit.

The tag push starts the Release workflow on that commit. It checks that the tag
matches `package.json`, that the commit is on `main`, and that CI passed on that
exact SHA — main only advances through the merge queue, so its successful
`merge_group` run is the receipt. A commit without one (pushed past branch
protection, say) gets the canonical CI workflow's full tier, dispatched on the
tag, before anything publishes. A successful staging build alone is not
evidence that tests passed. It then requires the public service images for the
SHA (built in the merge queue, so normally already there), builds and attests
the archives, aliases the images to `X.Y.Z`, `vX.Y.Z` and `latest`, and
publishes the GitHub release with the archives attached — last, so once it is
published the archives and images are live. The release body is `[Unreleased]`
at the tagged commit plus the tag message.

If `BIVY_RELEASE_DEPLOY_WORKFLOW` is set to `owner/repo/workflow.yml`,
`pnpm release` dispatches that workflow at the same moment with
`version=vX.Y.Z`, so a deployment can prepare while the release publishes and
cut over once the GitHub release exists. Finally it opens the follow-up PR
that records the notes under `## [X.Y.Z] - YYYY-MM-DD` and moves `main` to the
next patch; entries that landed after the tag stay under `[Unreleased]`. Merge
it before the next release.

To retry a failed promotion, dispatch the workflow from the tag:

```bash
gh workflow run release.yml --ref vX.Y.Z
```

The image aliases and the GitHub release are idempotent, and the archives are
rebuilt from the same commit. The protected tag keeps a retry on the original
commit.

## Self-contained archives

Every release publishes one archive per platform to GitHub Releases, built by
`scripts/release-archives.mjs` from a curated package directory (see "What
ships in the package"):

```text
bivy-<version>-<target>/      target: linux-x64, linux-arm64, darwin-x64, darwin-arm64
  bin/bivy                    launcher; runs app/bin/bivy.mjs on runtime/bin/node
  app/                        the curated package plus production node_modules
  runtime/                    pinned Node (node, npm, npx)
  bivy-archive.json           { version, target, node }
```

All four build on one Linux runner. Production dependencies are plain JS
except node-pty, and npm picks its prebuilt binary per `--os`/`--cpu` from one
shared lockfile. Each Node download is checked against nodejs.org's
`SHASUMS256.txt`. The Node version is `NODE_VERSION` in that script; adding a
platform is a row in `ARCHIVE_TARGETS`.

| Channel | Where | Updated |
|---|---|---|
| Production | the `vX.Y.Z` release (`releases/latest/download/manifest.json`) | by the production job |
| Staging | the rolling `staging` prerelease (`releases/download/staging/manifest.json`) | every merge to `main`; the newest three versions are kept |

Alongside the archives: `SHA256SUMS`, and `manifest.json` (version, commit,
Node version, and each archive's file, sha256 and size). Archives are attested
with GitHub's keyless build provenance (Sigstore, like npm's), so there is
still no release key to guard:

```bash
gh attestation verify bivy-0.22.0-linux-x64.tar.gz --repo bivysh/bivy
```

CI's package lane builds this machine's archive on every packaging change, and
`scripts/smoke-archive.mjs` checks it with no system Node on `PATH`:
- the launcher works through a symlink;
- the bundled Node and npm run;
- node-pty spawns a terminal;
- no agent SDK is in the archive;
- the daemon starts and serves `/healthz`.

## Service container images

```text
ghcr.io/bivysh/bivy-control-plane:<full-sha|version|latest>
ghcr.io/bivysh/bivy-relay:<full-sha|version|latest>
```

The full 40-character commit tag is write-once. Each tag is a multi-platform
OCI index for `linux/amd64` and `linux/arm64`. Both images carry OCI source,
revision, and MIT license labels plus SBOM and provenance attestations.
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

`scripts/build-release.mjs` stages a curated directory rather than shipping the
repository; each archive's `app/` is that directory plus its production
`node_modules`. It contains:

```text
bin/            the bivy CLI
dist/           compiled server, runtime adapters, CLI helpers
web/            the built web app, for a node reached directly
public/qr.js    QR rendering for `bivy link` and setup
package.json    with dev-only scripts, workspaces, and mobile deps removed
README.md
LICENSE
```

It deliberately excludes `src/`, `services/`, `deploy/`, `test/` and `docs/`.

## How users update

`bivy update` detects how Bivy was installed and does the right thing:

| Install kind | Update action |
|---|---|
| `archive` | downloads the channel's archive beside the running one, verifies its sha256, points `current` at it and restarts; points `current` back if the node doesn't come up |
| `git` | `git pull` + `pnpm install --frozen-lockfile`, then restart |
| `npm-global`, `packaged` | an older npm or tarball install: runs `install.sh` from `main` on the same channel, which moves it to the archive |
| `npx` | nothing to update |

An archive install's launcher passes the unresolved `current` path to Bivy
(`BIVY_ARCHIVE_ROOT`), so the service unit, shims and the daemon's own updater
name `current`, not a version, and survive the swap.

Every six hours the daemon checks the channel's `manifest.json` and posts an
in-session notice when a newer version exists. Override the endpoint
with `BIVY_UPDATE_REGISTRY_URL`, or the release host with `BIVY_RELEASES_URL`.
