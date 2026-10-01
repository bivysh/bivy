// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The access ladder: which setups are on, what the machine can do, and what the
// next step would add. `bivy access`, `bivy status` and the app all show this.
import { strict as assert } from "node:assert";
import test from "node:test";
import { accessReport } from "../src/access.js";
import { accessLine } from "../bin/access-view.mjs";

const hosted = "https://app.bivy.sh";
const next = (report: ReturnType<typeof accessReport>) => report.next.map((n) => `${n.id}:${n.adds.join(",")}`);

test("this machine only: every remote setup is a next step", () => {
  const report = accessReport({ hostedControlPlane: hosted });
  assert.deepEqual(report.active, ["local"]);
  assert.deepEqual(next(report), ["tailscale:devices,machines", "hosted:devices,machines,push,sharing", "server:devices,machines,push,sharing"]);
  assert.equal(accessLine(report), "This machine only — next: Tailscale or Bivy hosted ('bivy access')");
});

test("Tailscale reaches your devices and machines on your tailnet, and hosted widens that to anywhere", () => {
  const report = accessReport({ tailscaleHostname: "box.tail1.ts.net", hostedControlPlane: hosted });
  assert.equal(report.reach.devices, 1);
  assert.equal(report.reach.machines, 1);
  assert.equal(report.tailscaleUrl, "https://box.tail1.ts.net");
  assert.deepEqual(next(report), ["hosted:devices,machines,push,sharing", "server:devices,machines,push,sharing"]);
  assert.equal(report.next[0]!.addsText, "your phone and other devices and all your machines in one app from anywhere, push notifications and app previews");
});

test("a relay link is hosted or your own server by its control plane", () => {
  assert.deepEqual(accessReport({ relay: { controlPlaneUrl: "https://app.bivy.sh/" }, hostedControlPlane: hosted }).active, ["local", "hosted"]);
  assert.deepEqual(accessReport({ relay: { controlPlaneUrl: "https://bivy.example.com" }, hostedControlPlane: hosted }).active, ["local", "server"]);
  assert.deepEqual(accessReport({ relay: { room: "r", roomToken: "t" }, hostedControlPlane: hosted }).active, ["local", "server"]);
});

test("once linked, nothing is left to add: Tailscale gives nothing more, and hosted and a server are alternatives", () => {
  const report = accessReport({ relay: { controlPlaneUrl: hosted }, hostedControlPlane: hosted });
  assert.deepEqual(report.next, []);
  assert.equal(accessLine(report), "Bivy hosted");
});
