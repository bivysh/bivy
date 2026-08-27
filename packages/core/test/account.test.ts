// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  b64url,
  consumeLinkPayload,
  createLocalStore,
  fetchAccountNodes,
  startGithubDeviceLogin,
  pollDeviceLogin,
  fetchPairedDevices,
  removePairedDevice,
  logout,
  setGithubAppDefaultNode,
  setGithubAppTriggerAccess,
  disconnectGithubApp,
  fetchGithubApp,
  assignWorkItem,
  fetchEphemeralQueueDefault,
  setEphemeralQueueDefault,
  cancelAutomationRun,
  retryAutomationRun,
  fetchAutomationRun,
  RunFetchError,
  ManagedLaunchError,
  recordProductMetric,
  createManagedAuthRunner,
  launchManagedSessionMachine,
  restoreManagedSessionMachine,
  fetchEphemeralConfigs,
} from "../src/index.js";

describe("recordProductMetric", () => {
  it("sends only fixed content-free event and client fields", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://cp.test";
    let request: { url?: string; init?: RequestInit } = {};
    await recordProductMetric(store, "receipt_reviewed", "mobile", (async (url, init) => {
      request = { url: String(url), init };
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    expect(request.url).toBe("https://cp.test/account/product-events");
    expect(JSON.parse(String(request.init?.body))).toEqual({ event: "receipt_reviewed", client: "mobile" });
  });
});

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as unknown as Storage;
}

function encode(payload: unknown): string {
  return "#" + b64url(new TextEncoder().encode(JSON.stringify(payload)));
}

describe("consumeLinkPayload", () => {
  it("captures a session token + urls from a sign-in redirect hash", () => {
    const store = createLocalStore(mem(), mem());
    const ok = consumeLinkPayload(store, encode({ session: "tok123", controlPlane: "https://app.bivy.sh", relay: "wss://r" }));
    expect(ok).toBe(true);
    expect(store.s).toBe("tok123");
    expect(store.cp).toBe("https://app.bivy.sh");
    expect(store.relay).toBe("wss://r");
  });

  it("captures node id + pairing material from a QR link", () => {
    const store = createLocalStore(mem(), mem());
    consumeLinkPayload(store, encode({ node: { id: "n1", pub: "PUB" }, pairSecret: "SEC" }));
    expect(store.cur).toBe("n1");
    expect(store.nodePubs().n1).toBe("PUB");
    expect(store.pairSecrets().n1).toBe("SEC");
  });

  it("captures account-free (solo) room creds and no session from a solo QR", () => {
    const store = createLocalStore(mem(), mem());
    const ok = consumeLinkPayload(
      store,
      encode({ relay: "wss://relay.self", node: { id: "n2", pub: "PUB2" }, pairSecret: "SEC2", room: "room_abc", roomToken: "a".repeat(43) }),
    );
    expect(ok).toBe(true);
    expect(store.s).toBe(""); // no control-plane session in solo mode
    expect(store.cur).toBe("n2");
    expect(store.relay).toBe("wss://relay.self");
    expect(store.nodePubs().n2).toBe("PUB2");
    expect(store.pairSecrets().n2).toBe("SEC2");
    expect(store.solo().n2).toEqual({ room: "room_abc", roomToken: "a".repeat(43) });
  });

  it("makes the setup wizard's agent the first app draft choice", () => {
    const store = createLocalStore(mem(), mem());
    store.setLastChoice({ agentId: "pi" }); // stale choice from another node
    consumeLinkPayload(store, encode({
      session: "tok123",
      node: { id: "new-node" },
      defaultAgent: " Claude-Code-SDK ",
    }));
    expect(store.cur).toBe("new-node");
    expect(store.lastChoice().agentId).toBe("claude-code-sdk");
  });

  it("returns false for empty/garbage input", () => {
    const store = createLocalStore(mem(), mem());
    expect(consumeLinkPayload(store, "")).toBe(false);
    expect(consumeLinkPayload(store, "#not-base64!!")).toBe(false);
  });
});

describe("fetchAccountNodes", () => {
  it("GETs /nodes with the bearer token and returns the list", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenAuth = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)?.authorization || "");
      return { ok: true, json: async () => [{ id: "n1", name: "Laptop", online: true }] } as Response;
    }) as unknown as typeof fetch;
    const nodes = await fetchAccountNodes(store, fakeFetch);
    expect(seenUrl).toBe("https://app.bivy.sh/nodes");
    expect(seenAuth).toBe("Bearer tok");
    expect(nodes).toEqual([{ id: "n1", name: "Laptop", online: true }]);
  });
});

describe("setGithubAppDefaultNode", () => {
  it("POSTs the trimmed node label and returns the stored value", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ ok: true, defaultNode: "macbook" }) } as Response;
    }) as unknown as typeof fetch;
    const result = await setGithubAppDefaultNode(store, "macbook", undefined, fakeFetch);
    expect(seenUrl).toBe("https://app.bivy.sh/account/github-app/default-node");
    // No appId = every connected app, which is what the account-level setting wants.
    expect(JSON.parse(seenBody)).toEqual({ node: "macbook" });
    expect(result).toBe("macbook");
  });

  it("scopes the default to a single app when given an appId", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    let seenBody = "";
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ ok: true, defaultNode: "macbook" }) } as Response;
    }) as unknown as typeof fetch;
    await setGithubAppDefaultNode(store, "macbook", "12345", fakeFetch);
    expect(JSON.parse(seenBody)).toEqual({ node: "macbook", appId: "12345" });
  });

  it("throws with the server's error message on a non-2xx response", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () =>
      ({ ok: false, status: 404, json: async () => ({ error: "No GitHub App connected" }) }) as Response) as unknown as typeof fetch;
    await expect(setGithubAppDefaultNode(store, "macbook", undefined, fakeFetch)).rejects.toThrow("No GitHub App connected");
  });
});

describe("setGithubAppTriggerAccess", () => {
  it("POSTs the access level and returns the stored value", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ ok: true, triggerAccess: "contributor" }) } as Response;
    }) as unknown as typeof fetch;
    const result = await setGithubAppTriggerAccess(store, "contributor", undefined, fakeFetch);
    expect(seenUrl).toBe("https://app.bivy.sh/account/github-app/trigger-access");
    // No appId = every connected app, which is what the account-level setting wants.
    expect(JSON.parse(seenBody)).toEqual({ triggerAccess: "contributor" });
    expect(result).toBe("contributor");
  });

  it("scopes the setting to a single app when given an appId", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    let seenBody = "";
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ ok: true, triggerAccess: "collaborator" }) } as Response;
    }) as unknown as typeof fetch;
    await setGithubAppTriggerAccess(store, "collaborator", "12345", fakeFetch);
    expect(JSON.parse(seenBody)).toEqual({ triggerAccess: "collaborator", appId: "12345" });
  });

  it("defaults to 'everyone' when the response omits triggerAccess (cleared back to unrestricted)", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response) as unknown as typeof fetch;
    const result = await setGithubAppTriggerAccess(store, "everyone", undefined, fakeFetch);
    expect(result).toBe("everyone");
  });

  it("throws with the server's error message on a non-2xx response", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () =>
      ({ ok: false, status: 404, json: async () => ({ error: "No GitHub App connected" }) }) as Response) as unknown as typeof fetch;
    await expect(setGithubAppTriggerAccess(store, "contributor", undefined, fakeFetch)).rejects.toThrow("No GitHub App connected");
  });
});

describe("fetchGithubApp", () => {
  const appsResponse = {
    connected: true,
    name: "Bivy personal",
    mention: "bivy-personal",
    appId: "1",
    apps: [
      { connected: true, name: "Bivy personal", mention: "bivy-personal", appId: "1", servedBy: null },
      { connected: true, name: "Bivy acme", mention: "bivy-acme", appId: "2", servedBy: { id: "n1", online: true } },
    ],
  };

  it("returns every connected app alongside the flat first-app fields", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () => ({ ok: true, json: async () => appsResponse }) as Response) as unknown as typeof fetch;
    const info = await fetchGithubApp(store, fakeFetch);
    expect(info.connected).toBe(true);
    expect(info.apps.map((a) => a.appId)).toEqual(["1", "2"]);
    expect(info.name).toBe("Bivy personal");
  });

  it("derives a one-element list from a control plane that predates `apps`", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const flat = { connected: true, name: "Bivy", mention: "bivy", appId: "7", servedBy: null };
    const fakeFetch = (async () => ({ ok: true, json: async () => flat }) as Response) as unknown as typeof fetch;
    const info = await fetchGithubApp(store, fakeFetch);
    expect(info.apps).toEqual([flat]);
    expect(info.apps[0].servedBy).toBe(null);
  });

  it("reports nothing connected for either empty shape", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    for (const body of [{ connected: false, apps: [] }, { connected: false }]) {
      const fakeFetch = (async () => ({ ok: true, json: async () => body }) as Response) as unknown as typeof fetch;
      const info = await fetchGithubApp(store, fakeFetch);
      expect(info.connected).toBe(false);
      expect(info.apps).toEqual([]);
    }
  });
});

describe("disconnectGithubApp", () => {
  it("targets one app by id, and the whole account without one", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as unknown as typeof fetch;
    await disconnectGithubApp(store, "12 345", fakeFetch);
    await disconnectGithubApp(store, undefined, fakeFetch);
    expect(seen).toEqual([
      "https://app.bivy.sh/account/github-app?appId=12%20345",
      "https://app.bivy.sh/account/github-app",
    ]);
  });

  it("scopes a stale app (no App ID) to its hookId, not the whole account", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as unknown as typeof fetch;
    // appId wins when present; otherwise fall back to hookId; neither = wipe all.
    await disconnectGithubApp(store, { appId: "42", hookId: "hk_1" }, fakeFetch);
    await disconnectGithubApp(store, { hookId: "hk_9" }, fakeFetch);
    await disconnectGithubApp(store, {}, fakeFetch);
    expect(seen).toEqual([
      "https://app.bivy.sh/account/github-app?appId=42",
      "https://app.bivy.sh/account/github-app?hookId=hk_9",
      "https://app.bivy.sh/account/github-app",
    ]);
  });
});

describe("assignWorkItem", () => {
  it("POSTs node/runtime/model plus an ephemeral flag defaulting to false", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as unknown as typeof fetch;
    await assignWorkItem(store, "wi_1", { node: "laptop", runtimeId: "pi", model: "m" }, fakeFetch);
    expect(seenUrl).toBe("https://app.bivy.sh/account/work-items/wi_1/assign");
    expect(JSON.parse(seenBody)).toEqual({ node: "laptop", runtimeId: "pi", model: "m", ephemeral: false });
  });

  it("marks the item ephemeral when dispatched to a freshly-provisioned server (issue #532)", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    let seenBody = "";
    const fakeFetch = (async (_u: string, init?: RequestInit) => {
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as unknown as typeof fetch;
    await assignWorkItem(store, "wi_2", { node: "ab12cd34", ephemeral: true }, fakeFetch);
    expect(JSON.parse(seenBody)).toEqual({ node: "ab12cd34", runtimeId: "", model: "", ephemeral: true });
  });

  it("throws with the server's error message on a non-2xx response", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () =>
      ({ ok: false, status: 403, json: async () => ({ error: "Work item assignment is unavailable." }) }) as Response) as unknown as typeof fetch;
    await expect(assignWorkItem(store, "wi_3", {}, fakeFetch)).rejects.toThrow("unavailable");
  });
});

describe("ephemeral queue default (issue #532)", () => {
  it("fetchEphemeralQueueDefault GETs the account preference", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    const fakeFetch = (async (url: string) => {
      seenUrl = String(url);
      return { ok: true, json: async () => ({ enabled: true, provider: "hetzner", region: "nbg1" }) } as Response;
    }) as unknown as typeof fetch;
    const result = await fetchEphemeralQueueDefault(store, fakeFetch);
    expect(seenUrl).toBe("https://app.bivy.sh/account/ephemeral-default");
    expect(result).toEqual({ enabled: true, provider: "hetzner", region: "nbg1", size: undefined, ttlMinutes: undefined });
  });

  it("setEphemeralQueueDefault PUTs a partial patch and returns the merged value", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = String(init?.method || "");
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ enabled: true, provider: "fly" }) } as Response;
    }) as unknown as typeof fetch;
    const result = await setEphemeralQueueDefault(store, { enabled: true, provider: "fly" }, fakeFetch);
    expect(seenUrl).toBe("https://app.bivy.sh/account/ephemeral-default");
    expect(seenMethod).toBe("PUT");
    expect(JSON.parse(seenBody)).toEqual({ enabled: true, provider: "fly" });
    expect(result).toEqual({ enabled: true, provider: "fly", region: undefined, size: undefined, ttlMinutes: undefined });
  });

  it("throws with the server's error message on a non-2xx response", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () => ({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) }) as Response) as unknown as typeof fetch;
    await expect(setEphemeralQueueDefault(store, { enabled: true }, fakeFetch)).rejects.toThrow("Unauthorized");
  });
});

describe("paired devices", () => {
  it("fetchPairedDevices GETs /devices with the bearer token", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenAuth = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)?.authorization || "");
      return { ok: true, json: async () => [{ id: "pk-a", label: "Phone", updatedAt: "2026-01-01T00:00:00Z" }] } as Response;
    }) as unknown as typeof fetch;
    const devices = await fetchPairedDevices(store, fakeFetch);
    expect(seenUrl).toBe("https://app.bivy.sh/devices");
    expect(seenAuth).toBe("Bearer tok");
    expect(devices).toEqual([{ id: "pk-a", label: "Phone", updatedAt: "2026-01-01T00:00:00Z" }]);
  });

  it("removePairedDevice DELETEs /devices/:id (url-encoded)", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenMethod = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = String(init?.method || "");
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as unknown as typeof fetch;
    await removePairedDevice(store, "pk/a+b", fakeFetch);
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toBe("https://app.bivy.sh/devices/pk%2Fa%2Bb");
  });

  it("removePairedDevice throws on a non-2xx response", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(removePairedDevice(store, "pk-a", fakeFetch)).rejects.toThrow("404");
  });

  it("logout posts the device public key so the server frees the slot", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as unknown as typeof fetch;
    await logout(store, "device-pub-1", fakeFetch);
    expect(seenUrl).toBe("https://app.bivy.sh/auth/logout");
    expect(JSON.parse(seenBody)).toEqual({ devicePublicKeyB64: "device-pub-1" });
  });

  it("logout omits the device key when none is given", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    let seenBody = "";
    const fakeFetch = (async (_u: string, init?: RequestInit) => {
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as unknown as typeof fetch;
    await logout(store, undefined, fakeFetch);
    expect(JSON.parse(seenBody)).toEqual({});
  });
});

describe("managed account Machines", () => {
  it("preserves managed profiles and adopts the auth runner room key", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async (url: string) => {
      if (String(url).endsWith("/account/ephemeral-configs")) {
        return new Response(JSON.stringify([{ id: "managed-default", name: "Bivy Cloud", provider: "fly", computeSource: "managed" }]), { status: 200 });
      }
      return new Response(JSON.stringify({ machine: { id: "m-auth", provider: "fly", name: "Auth", region: "iad", status: "running", ip: null, createdAt: "", nodeId: "eph-auth" }, roomKey: "room-auth" }), { status: 201 });
    }) as typeof fetch;
    const configs = await fetchEphemeralConfigs(store, fakeFetch);
    expect(configs[0]?.computeSource).toBe("managed");
    await createManagedAuthRunner(store, fakeFetch);
    expect(store.keys()["eph-auth"]).toBe("room-auth");
  });

  it("launches an interactive managed Machine and adopts its one-time room key", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let body = "";
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body || "");
      return new Response(JSON.stringify({ machine: { id: "m-1", provider: "fly", name: "Cloud", region: "iad", status: "running", ip: null, createdAt: "", nodeId: "eph-1" }, roomKey: "room-1" }), { status: 201 });
    }) as typeof fetch;
    const machine = await launchManagedSessionMachine(store, "managed-default", { runtimeId: "codex", fetchImpl: fakeFetch });
    expect(JSON.parse(body)).toEqual({ configId: "managed-default", runtimeId: "codex" });
    expect(machine.nodeId).toBe("eph-1");
    expect(store.keys()["eph-1"]).toBe("room-1");
  });

  it("preserves deployment-owned remediation actions on launch denial", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () => new Response(JSON.stringify({
      reason: "Trial capacity exhausted",
      code: "quota_exhausted",
      actions: [
        { id: "upgrade", label: "Upgrade", kind: "primary" },
        { id: "byo", label: "Use my Machine", kind: "secondary" },
        { id: "", label: "invalid" },
      ],
    }), { status: 403 })) as typeof fetch;
    await expect(launchManagedSessionMachine(store, "managed-default", fakeFetch)).rejects.toMatchObject({
      name: "ManagedLaunchError",
      message: "Trial capacity exhausted",
      status: 403,
      code: "quota_exhausted",
      actions: [
        { id: "upgrade", label: "Upgrade", kind: "primary" },
        { id: "byo", label: "Use my Machine", kind: "secondary" },
      ],
    } satisfies Partial<ManagedLaunchError>);
  });

  it("restores a managed Machine and adopts escrowed key material on a fresh device", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let body = "";
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body || "");
      return new Response(JSON.stringify({ machine: { id: "m-restored", provider: "fly", name: "Cloud", region: "iad", status: "running", ip: null, createdAt: "", nodeId: "eph-old", computeSource: "managed" }, roomKey: "room-restored" }), { status: 201 });
    }) as typeof fetch;
    await restoreManagedSessionMachine(store, { configId: "managed-default", nodeId: "eph-old", sessionId: "s1" }, fakeFetch);
    expect(JSON.parse(body)).toEqual({ configId: "managed-default", nodeId: "eph-old", sessionId: "s1" });
    expect(store.keys()["eph-old"]).toBe("room-restored");
  });
});

describe("cancelAutomationRun", () => {
  it("POSTs the encoded account cancellation path and returns the run", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenMethod = "";
    let seenAuth = "";
    const run = { id: "run/a b", status: "cancelled" };
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = String(init?.method);
      seenAuth = String((init?.headers as Record<string, string>)?.authorization);
      return { ok: true, json: async () => ({ ok: true, run }) } as Response;
    }) as unknown as typeof fetch;

    await expect(cancelAutomationRun(store, "run/a b", fakeFetch)).resolves.toEqual(run);
    expect(seenUrl).toBe("https://app.bivy.sh/account/automation-runs/run%2Fa%20b/cancel");
    expect(seenMethod).toBe("POST");
    expect(seenAuth).toBe("Bearer tok");
  });

  it("surfaces terminal conflicts from the control plane", async () => {
    const store = createLocalStore(mem(), mem());
    const fakeFetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "Cannot cancel a succeeded automation run" }),
    }) as Response) as unknown as typeof fetch;
    await expect(cancelAutomationRun(store, "run-1", fakeFetch)).rejects.toThrow("Cannot cancel a succeeded automation run");
  });
});

describe("retryAutomationRun", () => {
  it("POSTs the encoded retry path and returns the same durable Run", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenMethod = "";
    const run = { id: "run/a b", status: "pending", attempt: 2 };
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = String(init?.method);
      return { ok: true, json: async () => ({ ok: true, run }) } as Response;
    }) as unknown as typeof fetch;
    await expect(retryAutomationRun(store, "run/a b", fakeFetch)).resolves.toEqual(run);
    expect(seenUrl).toBe("https://app.bivy.sh/account/automation-runs/run%2Fa%20b/retry");
    expect(seenMethod).toBe("POST");
  });

  it("surfaces attempt-limit conflicts", async () => {
    const store = createLocalStore(mem(), mem());
    const fakeFetch = (async () => ({ ok: false, status: 409, json: async () => ({ error: "This Run has reached its attempt limit." }) }) as Response) as unknown as typeof fetch;
    await expect(retryAutomationRun(store, "run-1", fakeFetch)).rejects.toThrow("attempt limit");
  });
});

describe("fetchAutomationRun", () => {
  it("GETs the encoded single-run path and returns the run", async () => {
    const store = createLocalStore(mem(), mem());
    store.s = "tok";
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenAuth = "";
    const run = { id: "run/a b", status: "running", title: "t", triggerKind: "manual", createdAt: "2026-08-12T00:00:00.000Z" };
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)?.authorization);
      return { ok: true, status: 200, json: async () => run } as Response;
    }) as unknown as typeof fetch;

    await expect(fetchAutomationRun(store, "run/a b", fakeFetch)).resolves.toEqual(run);
    expect(seenUrl).toBe("https://app.bivy.sh/account/automation-runs/run%2Fa%20b");
    expect(seenAuth).toBe("Bearer tok");
  });

  it("returns null for a non-leaking 404 (unknown or cross-account id)", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () => ({ ok: false, status: 404, json: async () => ({ error: "Automation run not found" }) }) as Response) as unknown as typeof fetch;
    await expect(fetchAutomationRun(store, "nope", fakeFetch)).resolves.toBeNull();
  });

  it("distinguishes unauthorized, offline, and other errors", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const unauth = (async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(fetchAutomationRun(store, "r", unauth)).rejects.toMatchObject({ reason: "unauthorized" });

    const offline = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(fetchAutomationRun(store, "r", offline)).rejects.toBeInstanceOf(RunFetchError);
    await expect(fetchAutomationRun(store, "r", offline)).rejects.toMatchObject({ reason: "error" });

    const boom = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(fetchAutomationRun(store, "r", boom)).rejects.toMatchObject({ reason: "error", status: 500 });
  });
});

describe("startGithubDeviceLogin", () => {
  it("POSTs /auth/device/github/start and returns credentials + authorize URL", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    let seenUrl = "";
    let seenMethod = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = String(init?.method || "");
      return {
        ok: true,
        json: async () => ({ ok: true, deviceId: "d1", deviceSecret: "s1", authorizeUrl: "https://app.bivy.sh/auth/github/start?device=d1", intervalMs: 3000, expiresInMs: 60000 }),
      } as Response;
    }) as unknown as typeof fetch;
    const login = await startGithubDeviceLogin(store, fakeFetch);
    expect(seenUrl).toBe("https://app.bivy.sh/auth/device/github/start");
    expect(seenMethod).toBe("POST");
    expect(login).toEqual({
      deviceId: "d1",
      deviceSecret: "s1",
      authorizeUrl: "https://app.bivy.sh/auth/github/start?device=d1",
      intervalMs: 3000,
      expiresInMs: 60000,
    });
  });

  it("throws when the control plane has GitHub sign-in disabled", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () =>
      ({ ok: false, json: async () => ({ error: "GitHub sign-in not configured" }) }) as Response) as unknown as typeof fetch;
    await expect(startGithubDeviceLogin(store, fakeFetch)).rejects.toThrow("GitHub sign-in not configured");
  });
});

describe("pollDeviceLogin", () => {
  it("POSTs device credentials and passes through the pending/complete status", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenBody = String(init?.body || "");
      return { ok: true, json: async () => ({ status: "complete", token: "sess-xyz" }) } as Response;
    }) as unknown as typeof fetch;
    const result = await pollDeviceLogin(store, "d1", "s1", fakeFetch);
    expect(JSON.parse(seenBody)).toEqual({ deviceId: "d1", deviceSecret: "s1" });
    expect(result).toEqual({ status: "complete", token: "sess-xyz" });
  });

  it("maps a non-2xx response to an error status", async () => {
    const store = createLocalStore(mem(), mem());
    store.cp = "https://app.bivy.sh";
    const fakeFetch = (async () =>
      ({ ok: false, status: 400, json: async () => ({ error: "Missing device credentials" }) }) as Response) as unknown as typeof fetch;
    const result = await pollDeviceLogin(store, "", "", fakeFetch);
    expect(result).toEqual({ status: "error", error: "Missing device credentials" });
  });
});
