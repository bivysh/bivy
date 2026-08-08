# Automation webhook recipes

Bivy webhooks turn signed events from CI, monitoring, or internal tools into ordinary queued runs on a machine you own. Prefer a **webhook-triggered automation** when you want a fully pre-configured job (machine, agent, model, sandbox, and encrypted instructions). A standalone hook is still available for ad-hoc instructions.

## Create a webhook-triggered automation (recommended)

In the Bivy app, open **Automations** → **New automation** (or a webhook template such as *Fix failed CI*):

1. Name the job and write the agent instructions (encrypted to the assigned machine).
2. On **When**, choose **Webhook** (or a schedule — same form, different trigger).
3. Optionally set a **Repository** (`owner/name`). The node clones it before the session starts. The event may also send `repo`; the definition wins when both are set.
4. Pick the machine (and optionally agent/model/autonomy), then create.
5. Copy the webhook URL and signing secret from the reveal panel. The secret is shown only at create/rotate time.

The endpoint is:

```text
POST /webhooks/automation/run/:definitionId
```

The payload may choose the node (`routing`) and supply event context; it cannot select runtime, model, sandbox, or the operator template. That boundary is deliberate — a leaked secret must not become RCE config.

## Create a standalone hook

In the Bivy app, open **Settings → Automations → Webhook triggers**.

1. Enter a fixed, safe instruction template, such as `Investigate this CI failure, make the smallest safe fix, run the relevant checks, and open a pull request.`
2. Optionally choose a default node.
3. Select **Create webhook**.
4. Save the signing secret immediately. It is only displayed when the hook is created or rotated.

The fixed template is prepended to every event. Event payloads cannot select commands, runtimes, models, or executable templates. The endpoint is `POST /webhooks/automation/:hookId`.

## Send an event

Every request needs:

- `Content-Type: application/json`
- `X-Bivy-Signature-256: sha256=<hex HMAC-SHA256 of the exact body>`
- `X-Bivy-Idempotency-Key: <stable unique event id>`

```bash
# Definition-bound (from Automations → webhook trigger):
endpoint='https://app.bivy.sh/webhooks/automation/run/YOUR_DEFINITION_ID'
# Or standalone hook:
# endpoint='https://app.bivy.sh/webhooks/automation/YOUR_HOOK_ID'
secret='YOUR_SIGNING_SECRET'
body='{"version":"1","instruction":"The Linux integration job failed. Reproduce it and fix the cause.","title":"CI follow-up","sourceUrl":"https://ci.example.com/build/123","externalId":"build-123","routing":"linux-runner","metadata":{"environment":"staging","attempt":2}}'

signature=$(printf %s "$body" \
  | openssl dgst -sha256 -hmac "$secret" -hex \
  | sed 's/^.* //')

curl -X POST "$endpoint" \
  -H 'Content-Type: application/json' \
  -H "X-Bivy-Signature-256: sha256=$signature" \
  -H 'X-Bivy-Idempotency-Key: build-123' \
  --data-binary "$body"
```

Sign the exact bytes sent with `--data-binary`. Reusing an idempotency key returns the existing run instead of creating a duplicate. For a definition-bound webhook, `instruction` is untrusted event context appended after the operator template — not a way to override the automation's configured job.

## Event schema

```json
{
  "version": "1",
  "instruction": "Required instruction for this event",
  "title": "Optional queue title",
  "sourceUrl": "https://example.com/events/123",
  "externalId": "optional-source-id",
  "routing": "optional-node-name",
  "repo": "owner/name",
  "metadata": {
    "environment": "staging",
    "attempt": 2,
    "regression": true
  }
}
```

Only these fields are accepted. `repo` is an optional GitHub slug used when the
automation definition did not set a workspace. `metadata` values must be strings,
finite numbers, or booleans. Treat metadata as untrusted context; never put
credentials or secrets in the payload.

## Recipe: failed CI build

Use the CI provider's immutable build or job id as the idempotency key. Keep the payload small: provide the build URL and failure category, then let the node fetch logs using credentials already held on that node.

```json
{
  "version": "1",
  "instruction": "Inspect the failed build, reproduce the failure locally, fix it, and run the affected checks.",
  "title": "Fix failed main build",
  "sourceUrl": "https://ci.example.com/build/8841",
  "externalId": "build-8841",
  "routing": "linux-runner",
  "metadata": { "branch": "main", "job": "integration" }
}
```

## Recipe: production alert

Do not ask an autonomous run to deploy or mutate production. Route investigation to a diagnostic workspace and make the fixed hook template require evidence and a proposed patch.

```json
{
  "version": "1",
  "instruction": "Investigate the alert using available read-only diagnostics. Produce a root-cause note and a tested patch; do not deploy.",
  "title": "Investigate checkout error-rate alert",
  "sourceUrl": "https://alerts.example.com/incidents/inc-294",
  "externalId": "inc-294",
  "metadata": { "service": "checkout", "severity": "high" }
}
```

## Recipe: internal task system

Map the external task id to both `externalId` and the idempotency key. Use `routing` when the task belongs on a machine with a particular operating system, network, or toolchain.

```json
{
  "version": "1",
  "instruction": "Implement the accepted task, run its required checks, and open a pull request that links the source task.",
  "title": "Implement ENG-431",
  "sourceUrl": "https://tasks.example.com/ENG-431",
  "externalId": "ENG-431",
  "routing": "mac-mini",
  "metadata": { "team": "developer-experience" }
}
```

## Responses and retries

- `202 accepted` — a new run was queued.
- `200 duplicate` — that source/idempotency key was already accepted.
- `400 invalid_request` — malformed body, unsupported schema, or missing/invalid idempotency key.
- `401 invalid_signature` — signature did not match the exact body.
- `410 disabled` — the hook has been disabled.
- `429 quota_exhausted` — rate limit, plan gate, or rolling run allowance prevented admission.

Retry network failures and `5xx` responses with exponential backoff. Reuse the same idempotency key for every retry of one logical event.

## Security checklist

- Store the signing secret in your CI or secret manager, never in a repository.
- Rotate the secret immediately if exposed; the old secret stops working at once.
- Never include model keys, repository tokens, customer data, or other secrets in event payloads.
- Use a narrowly scoped fixed instruction template.
- Route production alerts to read-only diagnostics and require human approval for deployment.
- Keep stable idempotency keys so provider retries cannot create duplicate work.
