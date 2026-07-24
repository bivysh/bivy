// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { NodeIdentity } from "./identity.js";
import { hostedEndpoints } from "./hosted-endpoints.mjs";

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

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const hint = defaultYes ? "Y/n" : "y/N";
  try {
    for (;;) {
      const answer = await new Promise<string>((resolve) => rl.question(`\n${question} (${hint})\n  > `, resolve));
      const v = answer.trim().toLowerCase();
      if (!v) return defaultYes;
      if (v === "y" || v === "yes") return true;
      if (v === "n" || v === "no") return false;
      console.log("Please answer yes or no.");
    }
  } finally {
    rl.close();
  }
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

function openBrowser(target: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(opener, [target], { stdio: "ignore", detached: true });
    // spawn reports a missing opener (e.g. no xdg-open on a headless server)
    // asynchronously via an 'error' event, not a throw. Without a listener that
    // becomes an unhandled error that crashes the process. The URL is printed too.
    child.on("error", () => {});
    child.unref();
  } catch {
    // best effort — the URL is also printed
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
    console.log(`\nOpening sign-in link (no email configured on the server):\n  ${start.devLink}`);
    openBrowser(start.devLink);
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
  console.log(`\nSign in with GitHub in your browser:\n  ${start.authorizeUrl}`);
  openBrowser(start.authorizeUrl);
  return pollDevice(controlPlaneUrl, start);
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const appDir = path.join(repoRoot, ".bivy");
  const endpoints = hostedEndpoints();
  const controlPlaneUrl = (arg("control-plane", process.env.BIVY_CONTROL_PLANE_URL) ?? endpoints.controlPlane).replace(/\/$/, "");
  const relayUrl = (arg("relay", process.env.BIVY_RELAY_URL) ?? endpoints.relay).replace(/\/$/, "");
  const clientBaseUrl = (arg("client", process.env.BIVY_CLIENT_BASE_URL) ?? endpoints.clientBaseUrl).replace(/\/$/, "") || controlPlaneUrl;
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

  let enrolled = await enrollNode();
  let enroll = enrolled.data;
  if (!enrolled.ok && enrolled.status === 402 && /node limit/i.test(String(enroll?.error ?? ""))) {
    const listed = await fetchJson(`${controlPlaneUrl}/nodes`, { headers: { authorization: `Bearer ${token}` } });
    const nodes = Array.isArray(listed.data) ? listed.data : [];
    if (nodes.length) {
      // Lead with the upgrade paths — subscribing or increasing the plan is the
      // intended way to add a node. Removing an existing node is the fallback.
      const accountUrl = `${clientBaseUrl}/?account=1`;
      console.log("\nYour plan's node limit is reached.");
      console.log(`To connect more nodes, subscribe or increase your plan:\n  ${accountUrl}`);
      console.log("\nOr free a slot by removing an existing node:");
      for (const [i, node] of nodes.entries()) {
        console.log(`  ${i + 1}. ${node.name ?? "Node"} — ${node.online ? "online" : "offline"} — ${node.id}`);
      }
      const replace = await askYesNo(`Remove ${nodes[0].name ?? nodes[0].id} and enroll this node instead?`, !nodes[0].online);
      if (replace) {
        const removed = await fetchJson(`${controlPlaneUrl}/nodes/${encodeURIComponent(nodes[0].id)}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!removed.ok) throw new Error(`Could not remove old node (${removed.status}): ${JSON.stringify(removed.data)}`);
        enrolled = await enrollNode();
        enroll = enrolled.data;
      }
    }
  }
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
