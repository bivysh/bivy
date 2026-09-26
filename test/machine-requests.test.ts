// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command, LocalStore, TransportHandlers } from "@bivy/core";
import { MachineRequests } from "../packages/web/src/store/machine-requests.js";

test("machine requests reach each machine on its own link without touching the selection", async () => {
  const local = { cur: "selected" } as LocalStore;
  const sent: { machine: string; command: Command }[] = [];
  let closed = 0;
  const requests = new MachineRequests(local, (store, handlers: TransportHandlers) => {
    const machine = store.cur;
    return {
      connect: async () => {
        if (machine === "offline") throw new Error("no route");
        handlers.onStatus("online");
      },
      send: (command: Command) => {
        sent.push({ machine, command });
        const requestId = command.requestId;
        queueMicrotask(() => handlers.onEvent(command.kind === "apps.remove"
          ? { type: "apps.remove.error", requestId, error: "App not found" }
          : { type: `${command.kind}.ok`, requestId, from: machine }));
      },
      close: () => { closed++; },
      reconnect: () => {},
    };
  }, 5);

  assert.equal((await requests.request("laptop", { kind: "artifacts.list" })).from, "laptop");
  assert.equal((await requests.request("server", { kind: "apps.list" })).from, "server");
  await assert.rejects(requests.request("server", { kind: "apps.remove" }), /App not found/);
  await assert.rejects(requests.request("offline", { kind: "apps.list" }), /not reachable/);
  assert.equal(local.cur, "selected");
  assert.deepEqual(sent.map((s) => s.machine), ["laptop", "server", "server"]);
  // Idle links close on their own.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, 3);
});
