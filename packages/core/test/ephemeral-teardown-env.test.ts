// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { buildBootstrapUserData, type BootstrapOpts } from "../src/index.js";

const base: BootstrapOpts = {
  relayUrl: "wss://relay.bivy.sh",
  controlPlaneUrl: "https://app.bivy.sh",
  enrollmentToken: "enroll-tok",
  e2eKeyB64: "e2e-key-b64",
  ttlMinutes: 90,
};

describe("bootstrap ephemeral self-teardown env", () => {
  it("emits BIVY_EPHEMERAL awareness for a destroy-lane provider + finish flag", () => {
    const ud = buildBootstrapUserData({ ...base, provider: "fly", teardownOnAgentFinish: true });
    expect(ud).toContain("export BIVY_EPHEMERAL=1");
    expect(ud).toContain("export BIVY_EPHEMERAL_PROVIDER='fly'");
    expect(ud).toContain("export BIVY_EPHEMERAL_TTL_MIN=90");
    expect(ud).toContain("export BIVY_TEARDOWN_ON_FINISH=1");
  });

  it("omits the finish flag when teardownOnAgentFinish is unset (idle-teardown only)", () => {
    const ud = buildBootstrapUserData({ ...base, provider: "hetzner" });
    expect(ud).toContain("export BIVY_EPHEMERAL=1");
    expect(ud).toContain("export BIVY_EPHEMERAL_PROVIDER='hetzner'");
    expect(ud).not.toContain("BIVY_TEARDOWN_ON_FINISH");
  });


  it("emits nothing when no provider is set (older/unaware bootstrap)", () => {
    expect(buildBootstrapUserData(base)).not.toContain("BIVY_EPHEMERAL");
  });

  it("emits BIVY_RESTORE for a rebuild-resume boot (Gap B), else omits it", () => {
    const restore = buildBootstrapUserData({ ...base, provider: "fly", restoreSessionId: "sess-xyz" });
    expect(restore).toContain("export BIVY_RESTORE='sess-xyz'");
    expect(buildBootstrapUserData({ ...base, provider: "fly" })).not.toContain("BIVY_RESTORE");
  });

  it("skips network installation when a runner image already has bivy", () => {
    const userData = buildBootstrapUserData({ ...base, provider: "hetzner" });
    expect(userData).toContain("command -v bivy >/dev/null 2>&1 || curl -fsSL");
  });
});
