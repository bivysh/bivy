# Missing runner image: staging launch failure (2026-09-15)

## Confirmed cause

Read-only inspection of staging's persisted failed launch found Fly HTTP 400:
`failed to get manifest … MANIFEST_UNKNOWN (HTTP 404)`.
The deployed Core revision was `2f6b1ef390c0154bed4bc4c482f48345d5c91fd8`.

Anonymous registry HEAD checks confirmed:

| Runner tag | HTTP |
| --- | --- |
| `2f6b1ef390c0154bed4bc4c482f48345d5c91fd8-staging-pi` | 404 |
| `2f6b1ef390c0154bed4bc4c482f48345d5c91fd8-staging` | 200 |
| `prebuild-2f6b1ef390c0154bed4bc4c482f48345d5c91fd8-pi` | 200 |

The image resolver appended `-pi` to the configured deployment alias even though
that derived tag was never published. This was not evidence of an account,
model-access, or feature-toggle failure. A provider create failure alone is not
proof that no ancillary provider resources exist.

## Fix

- Honor the configured baseline image literally; choose a runtime-specific image
  only when explicitly configured. No additional image builds are required.
- Translate manifest failures into a safe `managed_image_unavailable` response,
  without exposing provider bodies, registry credentials or bootstrap data.
- Attribute that error to machine creation; do not misclassify it as credential
  setup. Stop overlapping progress spinners when the launch fails.
- Offer same-request retry before machine creation is confirmed. Credential
  setup is offered only for an explicit credential-required error code.
- Hide the previous node's update banner while viewing a pending launch.

## Recovery scope

The code fix corrects image selection for new launch plans. Existing failed
attempts can retain their immutable image reference. Do not rewrite their
identity, bootstrap authority, or request intent to work around this error.
An operator can repair the missing alias by pointing it at the already-published
Pi image for the **same exact Core revision**, without rebuilding. Verify image
provenance and that the destination is still absent before publishing an alias;
never overwrite a published immutable tag. Such a repair may allow the existing
retry/reconciliation to start the requested billable machine, so it must be an
explicit operational action. Alternatively settle/clean up the old attempt before
starting a new request using the corrected deployment.

Investigation and local verification did not publish registry aliases, mutate
staging records, launch machines, or change billing. No new live agent continuity
claim is made by the unit/browser tests.
