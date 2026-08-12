# Receipt v1 specification

**Status:** Product contract; aggregation is not yet complete
**Parent contract:** [`product-contract.md`](product-contract.md)

A Receipt lets a developer answer: **What did this agent do, what did Bivy
allow, what could Bivy not see, and did the work pass?** It is a bounded,
redacted projection of durable Run and audit metadata—not a transcript, a diff,
or a compliance attestation.

## Required envelope

Every Receipt v1 contains:

- schema version, Receipt id, Run id, and underlying Session id;
- creation time, Run start/end, duration, terminal outcome, and outcome reason;
- attempts and bounded retry/fallback reasons;
- source kind and non-content source reference where available.

A Receipt may be generated before a Run finishes, but must identify itself as
partial and must not imply a terminal outcome.

## Execution identity

- Machine id and customer-readable name;
- execution profile: `trusted_workstation`, `isolated_customer_cloud`, or
  `restricted`;
- who controls the Machine: `customer` or `bivy_hosted_provisioning`;
- provider, region, and certified image/version where applicable;
- agent/runtime id and version, model id, and version availability status.

## Protection

Record requested and effective values separately:

- execution profile;
- sandbox tier;
- approval mode;
- runtime enforcement level;
- active trust modes, including hosted credential custody where applicable.

Each protection capability or decision has one evidence class:

- `enforced` — a named mechanism made the decision;
- `observed` — Bivy received the event but did not enforce it;
- `unavailable` — this runtime/Machine path could not provide it.

Approvals and denials include time, bounded action category, decision, evidence
class, and actor category. Tool and network decisions use bounded categories and
resource identifiers; they never include raw commands, arguments, payloads,
headers, output, or file contents.

## Changes and checks

- changed-file count and bounded path list only when the active metadata policy
  permits paths; otherwise counts and hashes;
- branch, commit, PR, checkpoint, and artifact references;
- deterministic checks with bounded name, command hash, required flag, status,
  duration, timeout indicator, and exit code;
- explicit no-change evidence when applicable.

Prompts, transcripts, reasoning, diffs, repository file contents, check output,
raw tool input/output, and secrets are prohibited.

## Completeness and limitations

Every Receipt has:

- `completeness`: `complete` or `partial`;
- an `auditHealth` result covering correlation, readable storage, and successful
  writes;
- an allowlisted list of missing evidence categories;
- customer-readable observation limitations for the effective runtime and
  Machine path.

Missing or unwritable audit data makes the Receipt partial and is displayed as a
warning. It must never be silently omitted or converted to `unavailable` unless
the capability was known in advance to be unavailable.

## Export

The PWA exports exactly the sanitized Receipt object as JSON. Export must not
serialize an enclosing queue/work-item object, cached transcript, prompt, diff,
or credential. Unknown fields are excluded by an allowlist before storage and
again before export. Strings, lists, and timelines are bounded.

## Integrity language

Receipt v1 reports what Bivy observed and enforced. It is **not** called a
provable attestation. A future attestation requires complete evidence,
tamper-evident storage, hash chaining, signing, key management, verification,
and documented retention semantics.

## Minimum acceptance tests

- terminal outcome cannot be inferred from process exit alone;
- requested and effective protection can differ and both remain visible;
- enforced, observed, and unavailable render distinctly;
- a missing audit write produces a partial Receipt warning;
- prohibited keys and oversized values are rejected, not silently stored;
- JSON export is the sanitized Receipt and contains no surrounding record;
- an approval deep-link lands on the exact decision represented in the Receipt;
- the Receipt remains understandable without opening the Session transcript.
