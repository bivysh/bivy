import { describe, expect, it } from "vitest";
import { activationFromState, deriveActivation, type ActivationSignals, type ActivationStateInput } from "../src/activation.js";

const ALL_BUT_AGENT: ActivationSignals = {
  accountSignedIn: true,
  machineOnline: true,
  agentInstalled: true,
  credentialValid: true,
  repositoryReady: true,
};

function stateOf(a: ReturnType<typeof deriveActivation>, id: string) {
  return a.checks.find((c) => c.id === id)?.state;
}

describe("deriveActivation", () => {
  it("exposes the six distinct checks in order", () => {
    const a = deriveActivation({});
    expect(a.checks.map((c) => c.id)).toEqual([
      "account_signed_in", "machine_online", "agent_installed", "credential_valid", "repository_ready", "agent_answered",
    ]);
  });

  it("is activated ONLY when a real agent answered — never from the chain alone", () => {
    // Every upstream signal green, but no agent response yet.
    const almost = deriveActivation(ALL_BUT_AGENT);
    expect(almost.activated).toBe(false);
    expect(almost.stage).toBe("in_progress");
    expect(stateOf(almost, "agent_answered")).toBe("checking");
    // Even an explicit not-yet is not success.
    expect(deriveActivation({ ...ALL_BUT_AGENT, agentAnswered: false }).activated).toBe(false);
    // Only the real answer flips it.
    const done = deriveActivation({ ...ALL_BUT_AGENT, agentAnswered: true });
    expect(done.activated).toBe(true);
    expect(done.stage).toBe("activated");
    expect(done.nextAction).toBeUndefined();
  });

  it("starts not_started when nothing is known and checks the first step", () => {
    const a = deriveActivation({});
    expect(a.stage).toBe("not_started");
    expect(stateOf(a, "account_signed_in")).toBe("checking");
    expect(stateOf(a, "machine_online")).toBe("pending");
    expect(a.nextAction?.checkId).toBe("account_signed_in");
  });

  it("blocks on the first failed check with exactly one remediation, downstream pending", () => {
    const a = deriveActivation({ accountSignedIn: true, machineOnline: true, agentInstalled: false, credentialValid: true, repositoryReady: true, agentAnswered: true });
    expect(a.stage).toBe("blocked");
    expect(a.blockingCheckId).toBe("agent_installed");
    const failed = a.checks.find((c) => c.id === "agent_installed");
    expect(failed?.state).toBe("failed");
    expect(failed?.remediation?.kind).toBe("install_agent");
    // A later green signal does not leak past the block: it stays pending, and
    // activation is NOT claimed despite agentAnswered:true upstream data.
    expect(stateOf(a, "credential_valid")).toBe("pending");
    expect(stateOf(a, "agent_answered")).toBe("pending");
    expect(a.activated).toBe(false);
    expect(a.nextAction).toEqual({ kind: "install_agent", label: "Install the agent", checkId: "agent_installed" });
  });

  it("gives each readiness failure class its own remediation", () => {
    const cases: Array<[keyof ActivationSignals, string]> = [
      ["accountSignedIn", "sign_in"],
      ["machineOnline", "connect_machine"],
      ["agentInstalled", "install_agent"],
      ["credentialValid", "authenticate_credential"],
      ["repositoryReady", "grant_repository"],
      ["agentAnswered", "run_starter_task"],
    ];
    for (const [signal, kind] of cases) {
      const a = deriveActivation({ ...ALL_BUT_AGENT, agentAnswered: true, [signal]: false });
      expect(a.blockingCheckId).toBeDefined();
      expect(a.nextAction?.kind).toBe(kind);
    }
  });

  it("surfaces running the starter task as the next action once the chain is green", () => {
    const a = deriveActivation(ALL_BUT_AGENT);
    expect(a.nextAction).toEqual({ kind: "run_starter_task", label: "Run the starter task", checkId: "agent_answered" });
  });

  it("marks the first unresolved check checking and the rest pending", () => {
    const a = deriveActivation({ accountSignedIn: true, machineOnline: true });
    expect(stateOf(a, "account_signed_in")).toBe("passed");
    expect(stateOf(a, "machine_online")).toBe("passed");
    expect(stateOf(a, "agent_installed")).toBe("checking");
    expect(stateOf(a, "credential_valid")).toBe("pending");
    expect(stateOf(a, "repository_ready")).toBe("pending");
    expect(stateOf(a, "agent_answered")).toBe("pending");
  });
});

describe("activationFromState", () => {
  const base: ActivationStateInput = {
    direct: false,
    signedIn: true,
    status: "online",
    runtimes: [{ status: "available", supportTier: "supported" }],
    providers: [{ configured: true }],
    reposAuthed: true,
    transcript: [],
  };

  it("resolves account_signed_in from the real sign-in state in hosted mode, but always true in direct mode", () => {
    expect(stateOf(activationFromState({ ...base, signedIn: false }), "account_signed_in")).toBe("failed");
    expect(stateOf(activationFromState({ ...base, direct: true, signedIn: false }), "account_signed_in")).toBe("passed");
  });

  it("requires a certified, supported agent — installed-but-unsupported does not satisfy the check", () => {
    const uncertified = activationFromState({ ...base, runtimes: [{ status: "available", supportTier: "experimental" }] });
    expect(uncertified.blockingCheckId).toBe("agent_installed");
    const noTier = activationFromState({ ...base, runtimes: [{ status: "available" }] });
    expect(noTier.blockingCheckId).toBe("agent_installed");
  });

  it("does not claim readiness from an online Machine + installed agent alone", () => {
    // Everything green upstream, but no real assistant response in the transcript.
    const a = activationFromState(base);
    expect(a.activated).toBe(false);
    expect(a.stage).toBe("in_progress");
    expect(stateOf(a, "agent_answered")).toBe("checking");
    expect(a.nextAction?.kind).toBe("run_starter_task");
  });

  it("activates only once a real assistant message with text exists", () => {
    const answered = activationFromState({
      ...base,
      transcript: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "Here's what I did.", tool: undefined },
      ],
    });
    expect(answered.activated).toBe(true);
    expect(answered.stage).toBe("activated");
  });

  it("ignores a tool card or empty assistant bubble as 'answered'", () => {
    const toolOnly = activationFromState({
      ...base,
      transcript: [
        { role: "assistant", text: "running tests", tool: { some: "activity" } },
        { role: "assistant", text: "" },
      ],
    });
    expect(toolOnly.activated).toBe(false);
  });

  it("treats a transient connection as checking, offline as a block", () => {
    expect(stateOf(activationFromState({ ...base, status: "reconnecting" }), "machine_online")).toBe("checking");
    const offline = activationFromState({ ...base, status: "offline" });
    expect(offline.blockingCheckId).toBe("machine_online");
    expect(offline.nextAction?.kind).toBe("connect_machine");
  });

  it("treats an expired credential as invalid", () => {
    const expired = activationFromState({ ...base, providers: [{ configured: true, expiresAt: 1000 }] }, 5000);
    expect(expired.blockingCheckId).toBe("credential_valid");
    const valid = activationFromState({ ...base, providers: [{ configured: true, expiresAt: 9000 }] }, 5000);
    expect(valid.blockingCheckId).not.toBe("credential_valid");
  });

  it("blocks on an unavailable agent and unauthorized repository", () => {
    expect(activationFromState({ ...base, runtimes: [{ status: "external" }] }).blockingCheckId).toBe("agent_installed");
    expect(activationFromState({ ...base, reposAuthed: false }).blockingCheckId).toBe("repository_ready");
  });
});
