# Product metrics contract

This internal contract describes the bounded product metrics emitted by the hosted control plane. Metrics are aggregate operational analytics, not user tracking. Labels are fixed product enums; events contain no account, node, Session, or Run IDs and no prompts, output, evidence, or other customer content.

## Measured now

- Existing launch funnel milestones: completed sign-in, Machine enrollment, Run start, quota block, checkout start, and plan change. Their source and plan labels are bounded before emission.
- Run lifecycle results: `bivy_run_lifecycle_results_total{outcome}` increments only after a successful durable transition through a node work endpoint or the account cancellation endpoint. The only outcomes are `succeeded`, `failed`, `needs_attention`, and `cancelled`.
- A matching content-free structured funnel log is emitted for each Run result.
- `bivy_product_events_total{event,client}` accepts only fixed event and client
  enums. Receipt review is emitted when an authenticated PWA successfully opens
  a durable Run and renders its Receipt. Remote reconnect is emitted after a
  previously-live relay transport reaches its Machine again; remote intervention
  is emitted when a hosted PWA answers an approval or question. Activation-ready
  is emitted once per browser after the Machine, runtime, credential, and
  repository checks all pass. First-useful-response is the current conservative
  name for the once-per-browser first live, non-tool assistant response; history
  replay is explicitly excluded, but actual usefulness still requires customer
  validation and must not be inferred from this counter alone. Run acceptance is
  emitted after a manual Automation or delegated Session returns a durably
  created Run. Event bodies contain no Run, Session, decision, question, Machine,
  account, or content identifier.

A retried request that cannot perform its transition does not emit another result. This measures durable transition events, not unique customers or Runs. `cancelled` is recorded only when the customer cancellation endpoint performs the durable transition; an idempotent repeat does not increment it again.

## Known gaps

The following are not measured yet and must not be inferred from current counters:

- time to first useful response or whether a response was useful;
- CLI setup does not yet emit activation milestones;
- elapsed-time histograms and stage conversion for activation and Run outcomes;
- automatic source-triggered Run acceptance is not represented by the PWA event
  (the durable queue and lifecycle counters cover those paths separately).

Remote reconnect and remote intervention are measured at the placements described
above. Those counters measure successful product events, not unique users or a
complete remote-continuity funnel.

Adding any gap requires a concrete product event, fixed low-cardinality labels, an explicit privacy review, and focused exactly-once placement tests. The broad implementation-plan metrics item remains open until the complete contracted funnel exists.
