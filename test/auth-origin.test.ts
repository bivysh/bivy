import assert from "node:assert";
import type { IncomingMessage } from "node:http";
import { requestOriginAllowed } from "../src/auth.js";

function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function run() {
  delete process.env.BIVY_ALLOW_ANY_ORIGIN;
  delete process.env.BIVY_ALLOWED_HOSTS;

  // Same-origin local UI — allowed.
  assert.equal(requestOriginAllowed(req({ host: "localhost:4317", origin: "http://localhost:4317" })), true, "loopback same-origin");
  assert.equal(requestOriginAllowed(req({ host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" })), true, "127.0.0.1 same-origin");

  // CLI / native / curl — no Origin header, loopback Host — allowed.
  assert.equal(requestOriginAllowed(req({ host: "localhost:4317" })), true, "no origin, loopback host");

  // LAN device browsing the node directly — allowed.
  assert.equal(requestOriginAllowed(req({ host: "192.168.1.5:4317", origin: "http://192.168.1.5:4317" })), true, "private LAN");
  assert.equal(requestOriginAllowed(req({ host: "10.0.0.9:4317", origin: "http://10.0.0.9:4317" })), true, "10/8 private");
  assert.equal(requestOriginAllowed(req({ host: "mymac.local:4317", origin: "http://mymac.local:4317" })), true, ".local mDNS");
  assert.equal(requestOriginAllowed(req({ host: "node.tailnet.ts.net", origin: "http://node.tailnet.ts.net" })), true, "tailscale ts.net");
  assert.equal(requestOriginAllowed(req({ host: "100.100.1.1:4317" })), true, "CGNAT/tailscale IP");

  // The attack: a public web page opening a cross-origin socket to the loopback
  // daemon — rejected on the Origin.
  assert.equal(requestOriginAllowed(req({ host: "localhost:4317", origin: "https://evil.example.com" })), false, "cross-origin public site");

  // DNS rebinding: browser connects to 127.0.0.1 but Host is the attacker domain
  // — rejected on the Host.
  assert.equal(requestOriginAllowed(req({ host: "evil.example.com", origin: "https://evil.example.com" })), false, "rebinding public host");
  assert.equal(requestOriginAllowed(req({ host: "evil.example.com:4317" })), false, "rebinding public host, no origin");

  // A malformed Origin is rejected.
  assert.equal(requestOriginAllowed(req({ host: "localhost:4317", origin: "not-a-url" })), false, "malformed origin");

  // Escape hatch: explicitly allowlisted reverse-proxy domain.
  process.env.BIVY_ALLOWED_HOSTS = "bivy.example.com";
  assert.equal(requestOriginAllowed(req({ host: "bivy.example.com", origin: "https://bivy.example.com" })), true, "allowlisted host");
  assert.equal(requestOriginAllowed(req({ host: "other.example.com" })), false, "non-allowlisted still blocked");
  delete process.env.BIVY_ALLOWED_HOSTS;

  // Full escape hatch.
  process.env.BIVY_ALLOW_ANY_ORIGIN = "1";
  assert.equal(requestOriginAllowed(req({ host: "evil.example.com", origin: "https://evil.example.com" })), true, "allow-any override");
  delete process.env.BIVY_ALLOW_ANY_ORIGIN;

  console.log("auth-origin: all tests passed");
}

run();
