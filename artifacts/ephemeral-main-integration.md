# Consolidating #678 into #940

PR #940 now targets `main` and incorporates #678's entire current head,
`b4544731d6d054b287f686d70e93b3f7e4bddece`, plus the reliability follow-up.
Main was merged at `6d81877b` rather than cherry-picked, preserving both histories.
The pre-integration branch is retained locally as
`backup/ephemeral-before-main-66f9d89a`; the original implementation stash remains
untouched.

## Integration resolutions

- Preserve managed admission, request receipts, custody, enrollment/room-key
  escrow, provider-confirmed cleanup and runtime reconstruction.
- Compose managed fork provisioning with main's modal-history dismissal,
  destination progress and source recovery on failure.
- Reuse main's shared one-time machine installation component and canonical
  installer, rather than retaining a second enrollment UI.
- Preserve both managed automation targets and main's editing/account-routing
  behavior, including encrypted credential-label templates.
- Carry main's per-session credential labels through encrypted snapshots, so a
  rebuild does not silently choose a different default account.
- Preserve main's source-aware deployment policy, webhook authentication, SQL
  timestamp casts, optional Pi bridge checks and native session discovery.
- Resolve duplicate URI overrides without losing the compatible patched pin;
  additionally pin patched Hono/qs versions for five reported advisories.

## Local verification

- 318 root suites passed.
- 698 core tests across 59 files passed.
- 51 control-plane suites passed.
- 372 Playwright tests passed (contracts, desktop and mobile; approximately six
  minutes with two workers). The deliberate API-isolation negative tests are
  expected failures and the overall command exits successfully.
- Root, web and control-plane typechecks passed; lint passed without errors.
- Design-token, module-boundary, route uniqueness and security-pin checks passed.
- Production dependency audit: no known vulnerabilities.
- Rendered the design-system styleguide and inspected first-task and automation
  UI screenshots in light/dark desktop/mobile states. Main's compact composer
  and progressive-disclosure layout are retained, without a duplicate summary.

The first full browser attempt was interrupted; an early update-prompt timing
failure did not recur in the completed full run. No assertion was weakened to
make that test pass.

The real provider/model continuity evidence in `ephemeral-continuity-live.json`
remains pinned to its recorded runner/control-plane versions. It predates this
main merge and is not represented as a fresh live certification of this merge.
No additional paid machines or model requests were used during integration.

Final CI and supersession status are recorded on PR #940; #678 is closed only
after the consolidated head passes CI.
