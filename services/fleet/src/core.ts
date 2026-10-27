// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Calls back into the control plane's /internal/compute/* with the shared
// compute token. Core owns node identity and the boot payload; the fleet only
// asks for them.
import type { CoreClient } from "./computers.js";

export function httpCoreClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): CoreClient {
  const post = async (path: string, body: unknown) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Core ${path} failed (${res.status})`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  return {
    async bootstrap(accountId, input) {
      const boot = await post("/internal/compute/bootstrap", { accountId, ...input });
      if (typeof boot.nodeId !== "string" || !Array.isArray(boot.files) || !boot.init) throw new Error("Core returned an invalid boot payload");
      return boot as unknown as Awaited<ReturnType<CoreClient["bootstrap"]>>;
    },
    async bootstrapRunner(accountId, input) {
      const boot = await post("/internal/compute/runner-bootstrap", { accountId, ...input });
      if (typeof boot.nodeId !== "string" || !Array.isArray(boot.files) || !boot.init) throw new Error("Core returned an invalid runner boot payload");
      return boot as unknown as Awaited<ReturnType<CoreClient["bootstrapRunner"]>>;
    },
    async retired(accountId, nodeId) {
      await post("/internal/compute/retired", { accountId, nodeId });
    },
    async notice(accountId, kind, deleteAt) {
      const result = await post("/internal/compute/notice", { accountId, kind, deleteAt });
      return { notified: result.notified === true };
    },
  };
}
