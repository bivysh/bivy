// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Relay-tunnelled attach bridge for `bivy run --node <account-node>`.
//
// Bivy has no node↔node link; a node reaches a sibling it co-owns exactly the
// way a phone reaches a node — as a CLIENT in the sibling's relay room. This
// process is that client. It:
//
//   1. Mints a client-scoped grant for the target node from THIS node's
//      enrollment token   (POST /node/sibling-link-grant),
//   2. Exchanges it for a single-use relay ticket
//      (POST /client/relay-ticket),
//   3. Opens the relay `/client` socket in the target's room, and
//   4. Pairs with `pair.account` to recover the target's rotating room key.
//
// After pairing it stands up a LOOPBACK WebSocket server that speaks the node's
// plain `/ws` protocol, and spawns the ordinary `attach` client against it. The
// two ends share ONE identical `terminal.*` message vocabulary — the only
// difference between a local `/ws` and the relay is the encrypted frame
// envelope — so the bridge is a pure translation layer and `attach` needs no
// relay awareness:
//
//   attach → local /ws  (bare terminal.* command JSON)
//          → seal + chunk → relay frames → target node
//   target node → relay frames → open + reassemble
//          → bare terminal.* event JSON → local /ws → attach
//
// The crypto + framing are the already-unit-tested node core
// (relay-cli-crypto.ts + relay-chunk.ts); the credential handshake mirrors
// SiblingClient (src/session/sibling-client.ts).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";

import { newDeviceKeypair, acceptWelcome, RoomCipher } from "./relay-cli-crypto.js";
import { frameMessages, FrameReassembler } from "./relay-chunk.js";
import type { PairingKeypair } from "./pairing-crypto.js";

type RelayFile = {
  url?: string;
  controlPlaneUrl?: string;
  enrollmentToken?: string;
  clientBaseUrl?: string;
};

type Args = {
  nodeId: string;
  nodeName: string;
  relayConfigPath: string;
  attachCmd: string[];
  run?: string;
  attachTermId?: string;
  label: string;
};

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
};

// All progress goes to STDERR: once `attach` binds the PTY it owns stdout in raw
// mode, so anything we print there would corrupt the terminal.
const note = (s: string) => process.stderr.write(s + "\n");

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
  };
  const nodeId = get("--node-id");
  const relayConfigPath = get("--relay-config");
  const attachCmdRaw = get("--attach-cmd");
  if (!nodeId || !relayConfigPath || !attachCmdRaw) {
    note("relay-attach: missing --node-id / --relay-config / --attach-cmd");
    process.exit(2);
  }
  let attachCmd: string[];
  try {
    attachCmd = JSON.parse(attachCmdRaw as string);
    if (!Array.isArray(attachCmd)) throw new Error("not an array");
  } catch {
    note("relay-attach: --attach-cmd must be a JSON array");
    process.exit(2);
  }
  return {
    nodeId: nodeId as string,
    nodeName: get("--node-name") || (nodeId as string),
    relayConfigPath: relayConfigPath as string,
    attachCmd,
    run: get("--run"),
    attachTermId: get("--attach"),
    label: get("--label") || "Bivy CLI (run --node)",
  };
}

function loadRelay(relayConfigPath: string): Required<Pick<RelayFile, "controlPlaneUrl" | "enrollmentToken">> & { url?: string } {
  let raw: RelayFile = {};
  try {
    raw = JSON.parse(fs.readFileSync(relayConfigPath, "utf8"));
  } catch {
    /* handled below */
  }
  const controlPlaneUrl = process.env.BIVY_CONTROL_PLANE_URL || raw.controlPlaneUrl;
  const enrollmentToken = process.env.BIVY_RELAY_TOKEN || raw.enrollmentToken;
  if (!controlPlaneUrl || !enrollmentToken) {
    note(c.red("relay-attach: relay is not configured (missing controlPlaneUrl/enrollmentToken). Run 'bivy relay:setup'."));
    process.exit(1);
  }
  return { controlPlaneUrl, enrollmentToken, url: process.env.BIVY_RELAY_URL || raw.url };
}

// Reuse ONE client device identity across runs so we don't spam the target
// node's device list with a fresh pairing on every `bivy run --node`.
function loadOrCreateDeviceKeypair(relayConfigPath: string): PairingKeypair {
  const file = path.join(path.dirname(relayConfigPath), "relay-cli-device.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.publicKeyB64 && data?.privateKeyB64) return data as PairingKeypair;
  } catch {
    /* create below */
  }
  const kp = newDeviceKeypair();
  try {
    fs.writeFileSync(file, JSON.stringify(kp), { mode: 0o600 });
  } catch {
    /* non-fatal: fall back to an ephemeral identity */
  }
  return kp;
}

async function postJson(url: string, bearer: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${url} → ${res.status} ${String(data.error || text).slice(0, 160)}`);
  return data;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const relay = loadRelay(args.relayConfigPath);
  const cp = relay.controlPlaneUrl.replace(/\/$/, "");
  const keypair = loadOrCreateDeviceKeypair(args.relayConfigPath);

  // 1. grant (enrollment-scoped) → 2. single-use relay ticket.
  note(c.dim(`Linking to ${c.cyan(args.nodeName)} over the relay…`));
  const grantRes = await postJson(`${cp}/node/sibling-link-grant`, relay.enrollmentToken, { nodeId: args.nodeId });
  const grant = String(grantRes.grant ?? "");
  if (!grant) throw new Error("sibling-link-grant returned no grant");
  const ticketRes = await postJson(`${cp}/client/relay-ticket`, grant, { nodeId: args.nodeId });
  const ticket = String(ticketRes.ticket ?? "");
  if (!ticket) throw new Error("relay-ticket returned no ticket");
  const relayBase = String(
    (typeof ticketRes.relayUrl === "string" && ticketRes.relayUrl) ||
      (typeof grantRes.relayUrl === "string" && grantRes.relayUrl) ||
      relay.url ||
      "",
  ).replace(/\/$/, "");
  if (!relayBase) throw new Error("no relay URL available for the target node");

  // 3. open the relay /client socket in the target's room and pair.
  const rly = new WebSocket(`${relayBase}/client?ticket=${encodeURIComponent(ticket)}&nodeId=${encodeURIComponent(args.nodeId)}`);
  const reassembler = new FrameReassembler();
  let cipher: RoomCipher | null = null;
  let local: WebSocket | null = null;
  let paired = false;
  let pairSent = false;

  const fail = (message: string, code = 1): never => {
    note(c.red(`\n${message}`));
    try {
      rly.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  const pairTimer = setTimeout(() => {
    if (!paired) fail(`Node "${args.nodeName}" did not respond to pairing — it may be offline.`, 1);
  }, 20_000);
  pairTimer.unref?.();

  const sendPair = () => {
    if (pairSent) return;
    pairSent = true;
    rly.send(
      JSON.stringify({
        t: "pair",
        // `ephemeral`: this is a transient CLI bridge, not a user device — the
        // control plane authorizes it but keeps it out of the account's
        // "Signed-in devices" list.
        p: JSON.stringify({ k: "pair.account", sessionToken: grant, devicePublicKeyB64: keypair.publicKeyB64, label: args.label, ephemeral: true }),
      }),
    );
  };

  rly.on("open", () => note(c.dim("Relay connected; pairing…")));
  rly.on("error", (err: Error) => fail(`Relay connection error: ${err.message}`, 1));
  rly.on("close", () => {
    if (!paired) fail("Relay closed before the session was established.", 1);
    // After pairing, a relay drop ends the remote session bridge; let the child exit.
    try {
      local?.close();
    } catch {
      /* ignore */
    }
  });

  rly.on("message", (data: unknown) => {
    let msg: { t?: string; p?: unknown };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t === "ready" || msg.t === "peer.online") {
      sendPair();
      return;
    }
    if (msg.t === "peer.offline") {
      if (!paired) fail(`Node "${args.nodeName}" is offline.`, 1);
      return;
    }
    if (msg.t === "error") {
      fail(`Relay error: ${String((msg as { message?: string }).message || msg.p || "unknown")}`, 1);
      return;
    }
    if (msg.t === "pair") {
      let p: { k?: string; nodePublicKeyB64?: string; wrapped?: string; error?: string };
      try {
        p = JSON.parse(String(msg.p));
      } catch {
        return;
      }
      if (p.k === "pair.welcome") {
        try {
          const roomKey = acceptWelcome(keypair, { nodePublicKeyB64: String(p.nodePublicKeyB64), wrapped: String(p.wrapped) });
          cipher = new RoomCipher(roomKey);
          paired = true;
          clearTimeout(pairTimer);
          startBridge();
        } catch (err) {
          fail(`Pairing failed: ${(err as Error).message}`, 1);
        }
      } else if (p.k === "pair.error") {
        fail(`Pairing rejected by ${args.nodeName}: ${p.error || "unknown reason"}`, 1);
      }
      return;
    }
    if (msg.t === "frame" && typeof msg.p === "string" && cipher) {
      const full = reassembler.accept(msg as { p: string });
      if (!full) return;
      let event: unknown;
      try {
        event = cipher.open(full).data;
      } catch {
        return; // undecryptable frame — ignore
      }
      // Forward the bare terminal.* event to the local attach socket verbatim.
      if (local && local.readyState === WebSocket.OPEN) local.send(JSON.stringify(event));
    }
  });

  // Stand up the loopback /ws server + spawn attach, only once paired.
  function startBridge(): void {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ws" });
    wss.on("connection", (sock: WebSocket) => {
      // A single attach client owns the bridge. Reject extras.
      if (local) {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        return;
      }
      local = sock;
      sock.on("message", (data: unknown) => {
        if (!cipher) return;
        let command: unknown;
        try {
          command = JSON.parse(String(data));
        } catch {
          return;
        }
        try {
          for (const frame of frameMessages(cipher.seal(command))) {
            if (rly.readyState === WebSocket.OPEN) rly.send(frame);
          }
        } catch {
          /* seal/send failure — the relay close handler will surface it */
        }
      });
      sock.on("close", () => {
        // attach detached or the remote session ended; tear down.
        try {
          rly.close();
        } catch {
          /* ignore */
        }
      });
    });

    wss.on("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const localUrl = `http://127.0.0.1:${port}`;
      const childArgs = [
        ...args.attachCmd,
        "--url",
        localUrl,
        ...(args.run ? ["--run", args.run] : []),
        ...(args.attachTermId ? ["--attach", args.attachTermId] : []),
      ];
      note(c.dim(`Paired ✓  starting session on ${c.cyan(args.nodeName)}\n`));
      const child = spawn(process.execPath, childArgs, { stdio: "inherit", env: process.env });
      child.on("exit", (code, signal) => {
        try {
          rly.close();
        } catch {
          /* ignore */
        }
        try {
          wss.close();
        } catch {
          /* ignore */
        }
        process.exit(signal ? 1 : code ?? 0);
      });
      child.on("error", (err: Error) => fail(`Could not start the attach client: ${err.message}`, 1));
    });

    wss.on("error", (err: Error) => fail(`Local bridge error: ${err.message}`, 1));
  }
}

main().catch((err: unknown) => {
  note(c.red(`relay-attach: ${(err as Error)?.message || String(err)}`));
  process.exit(1);
});
