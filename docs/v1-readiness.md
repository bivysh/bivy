# v1 readiness inspection

Assessment against the `0.16.12` worktree, including the fixes accompanying this
report. This is a bounded repository inspection, not a security audit or a
production-readiness certification. No release was published or version bumped.

## Conclusion

The existing product is substantial enough for a stabilization phase. Local
verification is green, but a 1.0 commitment still needs compatibility decisions,
upgrade/restore evidence, independent security review, and live-runtime release
qualification. More features are not the immediate prerequisite.

## Fixed in this pass

| Finding | Change and evidence |
| --- | --- |
| The node origin guard treated the literal `Origin: null` as equivalent to an absent header. | Reject opaque, empty, multiple, and non-HTTP origins. Preserve no-Origin CLI clients, local HTTP(S) origins, and explicit escape hatches. Regression tests failed before the fix and pass afterward. Both API middleware and WebSocket upgrades use this guard. |
| Production promotion verified staging publication but depended on branch protection for test evidence. | Make production depend on a reusable call to canonical CI with `force_all: true`, for the exact dispatch/ref commit. Retain staging, version, artifact, and environment gates. YAML contract tests guard the dependency and forced-job coverage; actual GitHub execution remains unverified here. |
| Checkout updates continued after failed Git pulls or dependency installs. | Return a nonzero exit status and stop before agent setup or service restart. Regression tests exercise both failures and successful restart behavior with injected effects. |
| Packaged updates could turn a failed `curl` into a successful empty `bash` invocation. | Enable shell `pipefail`; a test executes the actual pipeline arguments with a failing local curl substitute, without network access. |
| Troubleshooting overstated rollback guarantees. | Document in-place npm/Git updates separately from fallback tarball staging/swap recovery. No claim of transactional upgrades. |
| One unit suite rejected existing README prose because a Markdown blockquote wrapped across lines. | Normalize wrapping and blockquote prefixes in public-copy assertions without dropping the required product claims. |

## Verification performed

- Root test runner: **293/293 suites passed**, including installer migration,
  update failure paths, origin checks, and release-gate contracts.
- Shared core: **58 files, 673 tests passed**.
- Browser suite: **360 checks passed**, across configured desktop/mobile projects.
  This includes source-contract tests and rendered fixtures/screenshots; it is
  not 360 live-agent end-to-end workflows.
- Control plane: **41 suites passed**; relay unit/process/admission tests passed.
- Remote E2E: pairing, encrypted prompt/history/event traffic, and rejection of
  foreign-account access passed using local services.
- Linux release smoke: built the curated fallback archive, repacked it for npm,
  installed in clean project-local and global layouts, and verified CLI version,
  Pi discovery, and patched dependency versions. This does not prove a historical
  upgrade or macOS installation.
- Root, core, web, control-plane, and relay typechecks passed.
- Lint: **0 errors, 652 warnings**; warning cleanup remains debt.
- Design-token, module-boundary, duplicate-route, documentation-link, pinned
  dependency, and deterministic agent-certification checks passed.
- Production dependency audit passed its existing high/critical allowlist policy;
  this is not a claim that every dependency is vulnerability-free.

Some parallel checks initially timed out under load and passed when rerun. The
first remote-E2E attempt lacked service dependencies; it passed after installing
them. No failing check was waived to obtain the results above.

## Proposed remaining v1 gates

These are recommendations for maintainer approval, not newly adopted promises.

1. **Stable scope and compatibility policy.** Specify supported OS/agent paths,
   CLI and JSON contracts, configuration/automation schemas, persisted-data
   compatibility, and the supported node/web/control-plane version skew. Keep
   experimental capabilities explicitly outside the stable contract.
2. **Upgrade and restore qualification.** Test supported historical installations
   through upgrade, failed dependency install, failed service startup, and backup
   restoration. Include real session history and credentials. Current updates
   remain in-place on npm/Git paths; these fixes do not add automatic rollback.
3. **Independent security review.** Prioritize pairing authorization, local auth,
   credential sync, remote execution, and relay abuse controls. The documented
   heuristic local-auth default and relay-hardening limitations were not removed
   or comprehensively audited in this pass.
4. **Live certified-runtime qualification.** Run the live credential workflow for
   all advertised release-tested agent paths/platforms on a release candidate.
   Fixtures cannot establish compatibility with actual provider authentication
   and upstream processes. No provider credentials were used here.
5. **Operational failure drills and soak.** Exercise prolonged network loss,
   machine sleep, daemon/relay crashes, full disk, expired OAuth, and duplicate
   automation delivery with real installations. Confirm no silent loss of
   acknowledged work, unintended duplicate execution, or misleading completion.
6. **Release-system execution evidence.** Run the revised workflow in GitHub,
   including an intentional CI failure and recovery-ref qualification, without
   bypassing approval. Verify branch/environment settings and macOS artifact
   checks. Local YAML tests cannot prove GitHub configuration or publishing.

A release candidate should remain in representative use long enough to collect
failure/recovery evidence, with no known release-blocking security, data-loss,
or core-workflow bugs. The version number should follow that evidence.
