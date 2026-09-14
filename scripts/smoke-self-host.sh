#!/usr/bin/env bash
# Exercise the published production images in an isolated, disposable Compose
# project. No ports are published and no real domain/auth-provider is needed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export BIVY_IMAGE_TAG="${1:?Usage: bash scripts/smoke-self-host.sh <full-published-SHA>}"
[[ "$BIVY_IMAGE_TAG" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected full image SHA." >&2; exit 1; }
umask 077
TMP="$(mktemp -d)"
PROJECT="bivy-self-host-smoke-${TMP##*.}"
PROJECT="${PROJECT,,}"
mkdir "$TMP/deploy"
for file in self-host.sh common.sh Caddyfile docker-compose.yml; do cp "$ROOT/deploy/$file" "$TMP/deploy/$file"; done
compose() { docker compose -p "$PROJECT" -f "$TMP/deploy/docker-compose.yml" --env-file "$TMP/deploy/.env" "$@"; }
cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
SELF_HOST_SETUP_TOKEN="$(openssl rand -hex 32)" SELF_HOST_OWNER_EMAIL=owner@self-host.invalid DATABASE_URL= BIVY_SELF_HOST_CONFIG_ONLY=1 \
  bash "$TMP/deploy/self-host.sh" bivy.example.com
compose up -d --wait --wait-timeout 180 postgres control-plane relay
# Validate the actual generated one-domain route; do not request real ACME TLS.
compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# Pass the private link via stdin, never command-line arguments or CI logs.
OWNER_LINK="$(compose exec -T control-plane ./node_modules/.bin/tsx src/operator-login-cli.ts)"
printf '%s' "$OWNER_LINK" | compose exec -T control-plane node --input-type=module -e '
import assert from "node:assert/strict";
import fs from "node:fs";
const raw = fs.readFileSync(0, "utf8");
const link = new URL(raw.split("\n").find(line => line.startsWith("https://")));
const base = "http://127.0.0.1:4400";
assert.equal((await fetch(`${base}/readyz`)).status, 200);
const shell = await fetch(base).then(r => r.text());
assert.match(shell, /<script[^>]+src=/);
const disabled = await fetch(`${base}/auth/dev-login`, { method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({email: "attacker@example.com"}) });
assert.equal(disabled.status, 404);
const consumed = await fetch(`${base}${link.pathname}${link.search}`, { redirect: "manual" });
assert.equal(consumed.status, 302);
const payload = JSON.parse(Buffer.from(consumed.headers.get("location").split("#")[1], "base64url").toString());
assert.equal(payload.relay, "wss://bivy.example.com/relay");
assert.equal((await fetch(`${base}${link.pathname}${link.search}`)).status, 401);
async function post(route, token, body = {}) {
  const response = await fetch(`${base}${route}`, {method: "POST", headers: {"content-type": "application/json", authorization: `Bearer ${token}`}, body: JSON.stringify(body)});
  assert.equal(response.status, 200, route);
  return response.json();
}
// Browser setup uses only the image runtime environment and ordinary HTTP.
const password = "smoke-only-owner-password";
const owner = await post("/auth/owner/setup", "", {setupToken: process.env.SELF_HOST_SETUP_TOKEN, password});
const replay = await fetch(`${base}/auth/owner/setup`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({setupToken: process.env.SELF_HOST_SETUP_TOKEN, password})});
assert.equal(replay.status, 401);
const login = await post("/auth/owner/login", "", {password});
assert.equal(owner.relayUrl, payload.relay);
const enrolled = await post("/nodes/enroll", login.token, {nodeId: "self-host-smoke", name: "Smoke machine"});
const {ticket} = await post("/node/relay-ticket", enrolled.enrollmentToken);
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://relay:4500/node?ticket=${encodeURIComponent(ticket)}`);
  const timer = setTimeout(() => { ws.close(); reject(new Error("Relay ready timeout")); }, 10000);
  ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Relay connection failed")); });
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.t === "ready" && message.role === "node") { clearTimeout(timer); ws.close(); resolve(); }
  });
});
console.log("Self-host image smoke passed: PWA, durable shell/browser owner login, replay refusal, disabled dev login, node enrollment and relay handshake.");
'
