# Product metrics contract

This internal contract describes the bounded product metrics emitted by the hosted control plane. Metrics are aggregate operational analytics, not user tracking. Labels are fixed product enums; events contain no account, node, Session, or Run IDs and no prompts, output, evidence, or other customer content.

## Measured now

- Existing launch funnel milestones: completed sign-in, Machine enrollment, Run start, quota block, checkout start, and plan change. Their source and plan labels are bounded before emission.
- Run lifecycle results: `bivy_run_lifecycle_results_total{outcome}` increments only after a successful durable transition through a node work endpoint. The only outcomes are `succeeded`, `failed`, and `needs_attention`.
- A matching content-free structured funnel log is emitted for each Run result.

A retried request that cannot perform its transition does not emit another result. This measures durable transition events, not unique customers or Runs. There is deliberately no `cancelled` outcome: Bivy has no customer cancellation endpoint, so claiming cancellation would misrepresent the product.

## Known gaps

The following are not measured yet and must not be inferred from current counters:

- time to first useful response or whether a response was useful;
- remote reconnect or human intervention in a remote Session;
- Receipt opening or review;
- customer cancellation.

Adding any gap requires a concrete product event, fixed low-cardinality labels, an explicit privacy review, and focused exactly-once placement tests. The broad implementation-plan metrics item remains open until the complete contracted funnel exists.
