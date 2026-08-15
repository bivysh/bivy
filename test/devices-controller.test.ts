// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccessDeviceController, createLinkedDeviceController } from "../src/controllers/devices.js";

test("linked-device revocation owns one store transition and one effect", () => {
  let devices = [{ id: "a" }, { id: "b" }];
  const effects: unknown[] = [];
  const controller = createLinkedDeviceController({
    list: () => devices.map((device) => ({ ...device })),
    revoke: (id: string) => {
      if (!devices.some((device) => device.id === id)) return null;
      devices = devices.filter((device) => device.id !== id);
      return [{ deviceId: "b", wrapped: "next-key" }];
    },
    onRevoked: (id, deliveries, remaining) => effects.push({ id, deliveries, remaining }),
  });

  assert.deepEqual(controller.revoke("missing"), { found: false });
  assert.deepEqual(effects, [], "a failed lookup has no notification side effect");
  assert.deepEqual(controller.revoke("a"), { found: true, devices: [{ id: "b" }] });
  assert.deepEqual(effects, [{
    id: "a",
    deliveries: [{ deviceId: "b", wrapped: "next-key" }],
    remaining: [{ id: "b" }],
  }]);
});

test("access-device tokens pass through once and notify only successful changes", () => {
  let devices: Array<{ id: string; name: string }> = [];
  const events: unknown[] = [];
  const controller = createAccessDeviceController({
    list: () => devices.map((device) => ({ ...device })),
    create: (name: string) => {
      const device = { id: "token-device", name };
      devices.push(device);
      return { device, token: "raw-once" };
    },
    revoke: (id: string) => {
      const found = devices.some((device) => device.id === id);
      devices = devices.filter((device) => device.id !== id);
      return found;
    },
    onCreated: (device) => events.push({ type: "created", device }),
    onRevoked: (id) => events.push({ type: "revoked", id }),
  });

  assert.deepEqual(controller.create("Laptop"), {
    device: { id: "token-device", name: "Laptop" },
    token: "raw-once",
  });
  assert.equal(controller.revoke("missing"), false);
  assert.equal(controller.revoke("token-device"), true);
  assert.deepEqual(events, [
    { type: "created", device: { id: "token-device", name: "Laptop" } },
    { type: "revoked", id: "token-device" },
  ]);
});
