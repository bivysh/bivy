// SPDX-License-Identifier: AGPL-3.0-only
/** Deterministic certification trace runner shared by CI and integration authors. */
export interface CertificationFixture {
  agentId: string;
  protocolVersion: number;
  secretSentinel: string;
  scenarios: Record<string, Array<Record<string, unknown>>>;
}

export interface CertificationRun {
  scenario: string;
  events: Array<Record<string, unknown>>;
  transcript: string;
}

export class CertificationHarness {
  constructor(private readonly fixture: CertificationFixture) {}

  async run(scenario: string, signal?: AbortSignal): Promise<CertificationRun> {
    const events = this.fixture.scenarios[scenario];
    if (!events) throw new Error(`Missing certification scenario ${scenario} for ${this.fixture.agentId}`);
    if (signal?.aborted) throw signal.reason ?? new Error("Certification run cancelled");
    // Yield once so callers can exercise independent adapters concurrently and
    // cancellation can race deterministically without subprocess timing flakes.
    await Promise.resolve();
    if (signal?.aborted) throw signal.reason ?? new Error("Certification run cancelled");
    const transcript = JSON.stringify(events);
    if (transcript.includes(this.fixture.secretSentinel)) {
      throw new Error(`Secret leakage detected in ${this.fixture.agentId}/${scenario}`);
    }
    this.assertScenario(scenario, events);
    return { scenario, events: structuredClone(events), transcript };
  }

  private assertScenario(scenario: string, events: Array<Record<string, unknown>>): void {
    const has = (type: string, predicate: (event: Record<string, unknown>) => boolean = () => true) =>
      events.some((event) => event.type === type && predicate(event));
    const valid = scenario === "probe-install" ? has("probe.result", (event) => event.ok === true)
      : scenario === "auth-handoff" ? has("auth.ready", (event) => event.environment === "<redacted>")
      : scenario === "first-turn" ? has("session.started") && has("message.delta") && has("session.done")
      : scenario === "structured-streaming" ? events.filter((event) => event.type === "message.delta").length >= 2 && has("session.done")
      : scenario === "approval" ? has("tool.decision", (event) => event.decision === "allow") && has("tool.result", (event) => event.status === "ok")
      : scenario === "denial" ? has("tool.decision", (event) => event.decision === "deny") && has("tool.result", (event) => event.status === "denied")
      : scenario === "cancellation" ? has("session.cancelled")
      : scenario === "resume" ? has("session.resumed") && has("session.done")
      : scenario === "attachments" ? has("prompt.received", (event) => Array.isArray(event.attachments) && event.attachments.length > 0)
      : scenario === "token-refresh" ? has("auth.refresh", (event) => event.token === "<redacted>") && has("auth.ready")
      : scenario === "malformed-output" ? has("protocol.error", (event) => event.code === "malformed_output")
      : scenario === "version-drift" ? has("probe.result", (event) => event.ok === false && event.code === "unsupported_version")
      : false;
    if (!valid) throw new Error(`Certification scenario ${scenario} did not satisfy its contract for ${this.fixture.agentId}`);
  }
}

/** Copies only an explicit allowlist and never logs or returns secret values. */
export function prepareAuthHandoff(
  source: NodeJS.ProcessEnv,
  allowed: readonly string[],
): { environment: NodeJS.ProcessEnv; redactedAudit: Record<string, "<redacted>"> } {
  const environment: NodeJS.ProcessEnv = {};
  const redactedAudit: Record<string, "<redacted>"> = {};
  for (const name of allowed) {
    if (source[name] === undefined) continue;
    environment[name] = source[name];
    redactedAudit[name] = "<redacted>";
  }
  return { environment, redactedAudit };
}
