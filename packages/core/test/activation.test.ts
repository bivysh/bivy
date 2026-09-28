import { describe, expect, it } from "vitest";
import { activationFromState, deriveActivation, type ActivationSignals, type ActivationStateInput } from "../src/activation.js";

const READY: ActivationSignals = {
  accountSignedIn: true, machineOnline: true, agentInstalled: true,
  credentialValid: true, repositoryReady: true,
};
const stateOf = (a: ReturnType<typeof deriveActivation>, id: string) => a.checks.find((c) => c.id === id)?.state;

describe("deriveActivation", () => {
  it("is ready to send a message when setup passes, without an agent response", () => {
    const a = deriveActivation(READY);
    expect(a.activated).toBe(true);
    expect(a.stage).toBe("activated");
    expect(a.nextAction).toBeUndefined();
  });

  it("starts checking when nothing is known and leaves dependent checks pending", () => {
    const a = deriveActivation({});
    expect(a.stage).toBe("not_started");
    expect(stateOf(a, "account_signed_in")).toBe("checking");
    expect(stateOf(a, "machine_online")).toBe("pending");
    expect(a.nextAction?.checkId).toBe("account_signed_in");
  });

  it("blocks on the first failed check and leaves downstream checks pending", () => {
    const a = deriveActivation({ ...READY, agentInstalled: false });
    expect(a.stage).toBe("blocked");
    expect(a.blockingCheckId).toBe("agent_installed");
    expect(stateOf(a, "credential_valid")).toBe("pending");
    expect(stateOf(a, "repository_ready")).toBe("pending");
    expect(a.activated).toBe(false);
    expect(a.nextAction?.kind).toBe("install_agent");
  });

  it("gives each failure its own remediation", () => {
    const cases: Array<[keyof ActivationSignals, string]> = [
      ["accountSignedIn", "sign_in"], ["machineOnline", "connect_machine"],
      ["agentInstalled", "install_agent"], ["credentialValid", "authenticate_credential"],
      ["repositoryReady", "grant_repository"],
    ];
    for (const [signal, kind] of cases) {
      expect(deriveActivation({ ...READY, [signal]: false }).nextAction?.kind).toBe(kind);
    }
  });

  it("keeps unresolved credentials checking rather than reporting invalid credentials", () => {
    const a = deriveActivation({ ...READY, credentialValid: undefined });
    expect(a.stage).toBe("in_progress");
    expect(stateOf(a, "credential_valid")).toBe("checking");
    expect(stateOf(a, "repository_ready")).toBe("pending");
    expect(a.blockingCheckId).toBeUndefined();
  });
});

describe("activationFromState", () => {
  const base: ActivationStateInput = {
    direct: false, signedIn: true, status: "online",
    runtimes: [{ status: "available", supportTier: "supported" }],
    readiness: { credential: { ok: true }, repository: { ok: true } },
  };

  it("uses hosted sign-in state but requires no account in direct mode", () => {
    expect(stateOf(activationFromState({ ...base, signedIn: false }), "account_signed_in")).toBe("failed");
    expect(activationFromState({ ...base, direct: true, signedIn: false }).activated).toBe(true);
  });

  it("requires a certified, supported, available agent", () => {
    for (const runtime of [{ supportTier: "experimental" }, {}, { status: "external", supportTier: "supported" }]) {
      expect(activationFromState({ ...base, runtimes: [runtime] }).blockingCheckId).toBe("agent_installed");
    }
  });

  it("uses authoritative readiness, and waits while credentials sync or probes are pending", () => {
    expect(activationFromState(base).activated).toBe(true);
    expect(stateOf(activationFromState({ ...base, readiness: null }), "credential_valid")).toBe("checking");
    const failed = activationFromState({ ...base, readiness: { ...base.readiness!, credential: { ok: false } } });
    expect(failed.blockingCheckId).toBe("credential_valid");
  });

  it("treats a transient connection as checking and offline as a block", () => {
    expect(stateOf(activationFromState({ ...base, status: "reconnecting" }), "machine_online")).toBe("checking");
    expect(activationFromState({ ...base, status: "offline" }).blockingCheckId).toBe("machine_online");
  });

  it("blocks when the machine workspace is unavailable", () => {
    expect(activationFromState({ ...base, readiness: { credential: { ok: true }, repository: { ok: false } } }).blockingCheckId).toBe("repository_ready");
  });
});
