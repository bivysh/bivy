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
    if (scenario === "malformed-output" && !events.some((event) => event.type === "protocol.error")) {
      throw new Error(`Malformed output was not contained for ${this.fixture.agentId}`);
    }
    return { scenario, events: structuredClone(events), transcript };
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
