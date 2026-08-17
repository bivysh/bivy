// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIdentity } from "./identity.js";
import { hostedEndpoints } from "./hosted-endpoints.mjs";
import { openBrowser } from "./browser-open.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * One-time node relay setup.
 *
 * Signs into the control plane (hands-free magic-link by default), enrolls THIS
 * node (using its stable nodeId), generates an E2E key, and writes
 * `.bivy/relay.json`. After this the daemon dials the relay automatically
 * on next start.
 *
 * Endpoints default to the baked-in hosted service (see hosted-endpoints.mjs);
 * a user never has to type a URL. Everything is overridable for self-hosting:
 *
 *   npm run relay:setup -- --email you@example.com
 *   BIVY_HOSTED_DOMAIN=bivy.sh npm run relay:setup -- --email you@…
 *   npm run relay:setup -- --control-plane https://app.x --relay wss://relay.x \
 *     --email you@example.com
 *
 * Sign-in is hands-free: we email a link, you click it in a browser, and this
 * command detects completion by polling. Pass `--session-token` to skip sign-in
 * when you already have an account session.
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${url}: ${message}`);
  }
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function checkControlPlane(controlPlaneUrl: string): Promise<void> {
  // /me returns 401 when healthy and unauthenticated. That is good enough to
  // catch DNS/TLS/reverse-proxy mistakes before the user waits for email.
  try {
    const response = await fetch(`${controlPlaneUrl}/me`);
    if (response.status === 401 || response.ok) return;
    throw new Error(`health check returned HTTP ${response.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Hosted control plane is not reachable at ${controlPlaneUrl}. ${message}`);
  }
}

/** Poll a started device login until it completes; returns the session token. */
async function pollDevice(
  controlPlaneUrl: string,
  start: { deviceId: string; deviceSecret: string; intervalMs?: number; expiresInMs?: number },
): Promise<string> {
  const intervalMs = Number(start.intervalMs) || 2000;
  const deadline = Date.now() + (Number(start.expiresInMs) || 15 * 60_000);
  process.stdout.write("Waiting for you to finish sign-in");
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    process.stdout.write(".");
    const pollResult = await fetchJson(`${controlPlaneUrl}/auth/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: start.deviceId, deviceSecret: start.deviceSecret }),
    }).catch(() => null);
    const poll = pollResult?.data;
    if (poll?.status === "complete" && poll.token) {
      process.stdout.write("\n");
      return poll.token as string;
    }
    if (poll?.status === "expired") break;
  }
  process.stdout.write("\n");
  throw new Error("Sign-in timed out or expired. Run setup again.");
}

/**
 * Hands-free magic-link sign-in. Emails a link, opens/prints it, polls until
 * clicked. Returns an account session token.
 */
async function deviceLogin(controlPlaneUrl: string, email: string): Promise<string> {
  const started = await fetchJson(`${controlPlaneUrl}/auth/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const start = started.data;
  if (!started.ok || !start?.deviceId || !start?.deviceSecret) {
    throw new Error(`Sign-in could not start (${started.status}): ${JSON.stringify(start)}`);
  }

  if (start.devLink) {
    const opened = openBrowser(start.devLink);
    console.log(opened
      ? `\nOpening sign-in link (no email configured on the server):\n  ${start.devLink}`
      : `\nNo email configured on the server — open this sign-in link in a browser (this machine has none):\n  ${start.devLink}`);
  } else {
    console.log(`\nWe emailed a sign-in link to ${email}. Open it in your browser to continue.`);
  }
  return pollDevice(controlPlaneUrl, start);
}

/**
 * Hands-free GitHub sign-in (primary). Opens the GitHub authorize URL and polls
 * until the OAuth callback completes the device login. Returns a session token.
 */
async function githubDeviceLogin(controlPlaneUrl: string): Promise<string> {
  const started = await fetchJson(`${controlPlaneUrl}/auth/device/github/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const start = started.data;
  if (started.status === 501) throw new Error("GitHub sign-in is not enabled on this control plane. Use --email instead.");
  if (!started.ok || !start?.deviceId || !start?.authorizeUrl) {
    throw new Error(`GitHub sign-in could not start (${started.status}): ${JSON.stringify(start)}`);
  }
  const opened = openBrowser(start.authorizeUrl);
  console.log(opened
    ? `\nSign in with GitHub in your browser:\n  ${start.authorizeUrl}`
    : `\nSign in with GitHub — open this link in a browser on any device (this machine has none):\n  ${start.authorizeUrl}`);
  return pollDevice(controlPlaneUrl, start);
}

/**
 * Generate account-free ("solo") relay credentials and write a control-plane-free
 * relay.json: `{ url, room, roomToken }` (+ optional clientBaseUrl). No sign-in,
 * no enrollment, no hosted service - the node authorizes onto a self-hosted relay
 * (started with RELAY_ALLOW_ROOM_TOKENS=1) with the room id + bearer token, both
 * of which travel to the phone only in the pairing QR (see `bivy link`). Both are
 * high-entropy so the room id is unguessable and the token clears the relay's
 * MIN_ROOM_TOKEN_LEN=22 floor.
 */
function generateSoloConfig(): { room: string; roomToken: string } {
  return {
    room: `room_${randomBytes(16).toString("hex")}`, // 32 hex chars, unguessable
    roomToken: randomBytes(32).toString("base64url"), // 43 chars, >= 22 floor
  };
}

async function runSolo() {
  const repoRoot = path.resolve(__dirname, "..");
  const appDir = process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy");
  const relayUrl = (arg("relay", process.env.BIVY_RELAY_URL) ?? "").replace(/\/$/, "");
  if (!relayUrl) {
    throw new Error("Solo setup needs a relay: pass --relay <wss url> (your self-hosted relay started with RELAY_ALLOW_ROOM_TOKENS=1).");
  }
  const clientBaseUrl = arg("client", process.env.BIVY_CLIENT_BASE_URL)?.replace(/\/$/, "");
  const identity = NodeIdentity.load(appDir);
  const { room, roomToken } = generateSoloConfig();
  const config: { url: string; room: string; roomToken: string; clientBaseUrl?: string } = { url: relayUrl, room, roomToken };
  if (clientBaseUrl) config.clientBaseUrl = clientBaseUrl;

  const filePath = path.join(appDir, "relay.json");
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);

  console.log(`Node:  ${identity.name} (${identity.nodeId})`);
  console.log(`Relay: ${relayUrl}  (account-free / solo)`);
  console.log(`\nGenerated solo relay credentials (kept only in ${filePath} and the pairing QR):`);
  console.log(`  room:      ${room}`);
  console.log(`  roomToken: ${roomToken}`);
  console.log(`\n✓ Wrote ${filePath} (no control plane).`);
  console.log('Restart the node (or POST /api/relay/reload), then run "bivy link" to pair a phone.');
}

async function main() {
  // Account-free path: no sign-in, no enrollment, no hosted control plane.
  if (process.argv.includes("--solo")) {
    await runSolo();
    return;
  }
  const repoRoot = path.resolve(__dirname, "..");
  // Honor the same override as every other entry point (server.ts, native-pi.ts,
  // bivy-login.ts, secrets-cli.ts, …) so a global/packaged install writes
  // relay.json and the node identity into the real data dir instead of a
  // package directory that gets wiped on update. See issue #2.
  const appDir = process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy");
  const endpoints = hostedEndpoints();
  const controlPlaneUrl = (arg("control-plane", process.env.BIVY_CONTROL_PLANE_URL) ?? endpoints.controlPlane).replace(/\/$/, "");
  const relayUrl = (arg("relay", process.env.BIVY_RELAY_URL) ?? endpoints.relay).replace(/\/$/, "");
  // The remote web client is served by whichever control plane we just resolved,
  // so default it to `controlPlaneUrl` — NOT `endpoints.clientBaseUrl`, which is
  // derived from env/baked-in defaults and would point at the hosted app even
  // when the user picked self-hosted (the control-plane URL arrives via
  // --control-plane, not the environment). An explicit --client / BIVY_CLIENT_BASE_URL
  // still wins for setups that serve the web app from a separate origin.
  const clientBaseUrl = (arg("client", process.env.BIVY_CLIENT_BASE_URL) ?? controlPlaneUrl).replace(/\/$/, "") || controlPlaneUrl;
  const email = arg("email", process.env.BIVY_EMAIL);
  const sessionToken = arg("session-token", process.env.BIVY_SESSION_TOKEN);
  // GitHub is the primary sign-in: used when --github is passed, or by default
  // when neither an email nor an existing session token is supplied.
  const useGithub = process.argv.includes("--github") || process.env.BIVY_AUTH === "github" || (!email && !sessionToken);

  const identity = NodeIdentity.load(appDir);
  console.log(`Node: ${identity.name} (${identity.nodeId})`);
  console.log(`Control plane: ${controlPlaneUrl}`);
  console.log(`Relay:         ${relayUrl}`);

  await checkControlPlane(controlPlaneUrl);
  const token = sessionToken ?? (useGithub ? await githubDeviceLogin(controlPlaneUrl) : await deviceLogin(controlPlaneUrl, email!));

  async function enrollNode() {
    return fetchJson(`${controlPlaneUrl}/nodes/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ nodeId: identity.nodeId, name: identity.name }),
    });
  }

  const enrolled = await enrollNode();
  const enroll = enrolled.data;
  if (!enrolled.ok || !enroll?.enrollmentToken) throw new Error(`Enroll failed (${enrolled.status}): ${JSON.stringify(enroll)}`);

  // The control plane keeps node names unique per account, so a colliding name may
  // have been auto-suffixed (e.g. "Mac-2"). Adopt the assigned name locally so the
  // node serves the matching `bivy/<name>` label (and the UI agrees on the name).
  const assignedName = typeof enroll?.node?.name === "string" ? enroll.node.name : undefined;
  if (assignedName && assignedName !== identity.name) {
    try {
      identity.setName(assignedName);
      console.log(`Node name adjusted to "${assignedName}" (kept unique on your account).`);
    } catch {
      /* non-fatal — routing still works via the shared bivy label */
    }
  }

  const config = {
    url: relayUrl,
    controlPlaneUrl,
    clientBaseUrl,
    enrollmentToken: enroll.enrollmentToken,
  };
  const filePath = path.join(appDir, "relay.json");
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);

  // Optional handoff: when `bivy setup` runs us with --emit-session, drop the
  // account session we just obtained (plus this node's id) into a 0600 file so
  // setup can open the remote app signed into the whole account — not a
  // node-scoped grant that would show only this node. The account bearer never
  // goes into relay.json (the node keeps only its enrollment token); this file is
  // read once and deleted by setup. We skip it when the caller supplied a session
  // token only via --session-token/env with no --emit-session, i.e. non-setup use.
  const emitSession = arg("emit-session");
  if (emitSession) {
    try {
      const handoff = JSON.stringify({ session: token, nodeId: identity.nodeId });
      fs.writeFileSync(emitSession, `${handoff}\n`, { mode: 0o600 });
      fs.chmodSync(emitSession, 0o600);
    } catch {
      // best effort — setup falls back to opening the plain remote app URL
    }
  }

  console.log(`\n✓ Signed in and enrolled this node. Wrote ${filePath}`);
  console.log('Run "bivy link" to pair a phone, or use "Link remote device" in the app (bivy open).');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
