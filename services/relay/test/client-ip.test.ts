// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { clientAddress, parseTrustedProxies } from "../src/client-ip.js";

const behindCaddy = parseTrustedProxies("uniquelocal");

test("without trusted proxies the socket peer is the client, whatever it forwards", () => {
  assert.equal(clientAddress("203.0.113.9", "198.51.100.1", parseTrustedProxies(undefined)), "203.0.113.9");
  assert.equal(clientAddress("172.18.0.5", "198.51.100.1", parseTrustedProxies("")), "172.18.0.5");
});

test("behind a trusted proxy each client counts on its own address", () => {
  assert.equal(clientAddress("::ffff:172.18.0.5", "198.51.100.1", behindCaddy), "198.51.100.1");
  assert.equal(clientAddress("172.18.0.5", "198.51.100.2", behindCaddy), "198.51.100.2");
});

test("a client can't pick its address by prepending X-Forwarded-For hops", () => {
  assert.equal(clientAddress("172.18.0.5", "10.0.0.1, 192.0.2.7, 198.51.100.1", behindCaddy), "198.51.100.1");
  assert.equal(clientAddress("172.18.0.5", "not-an-ip, 198.51.100.1", behindCaddy), "198.51.100.1");
  assert.equal(clientAddress("172.18.0.5", "198.51.100.1, garbage", behindCaddy), "172.18.0.5", "an unreadable nearest hop falls back to the proxy");
  assert.equal(clientAddress("172.18.0.5", undefined, behindCaddy), "172.18.0.5");
});

test("RELAY_TRUST_PROXY accepts IPs, CIDRs and named subnets, and refuses anything else", () => {
  const trusted = parseTrustedProxies("192.0.2.10, 2001:db8::/32, loopback");
  assert.equal(trusted("192.0.2.10"), true);
  assert.equal(trusted("2001:db8::1"), true);
  assert.equal(trusted("127.0.0.1"), true);
  assert.equal(trusted("192.0.2.11"), false);
  for (const bad of ["true", "1", "10.0.0.0/33", "proxy.example"]) assert.throws(() => parseTrustedProxies(bad), /RELAY_TRUST_PROXY/);
});
