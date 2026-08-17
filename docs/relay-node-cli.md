# Relay-tunnelled CLI routing (`bivy run --node <account-node>`)

Run an agent session on another node you own, from the CLI, without any direct
network route between the two machines. The session runs on the target node; its
PTY streams to your terminal over the hosted relay, end-to-end encrypted.

```
bivy run claude --node hetzner-bivy-staging
```

`--node` accepts two kinds of target. A **direct** node is a registry entry with
a reachable URL (`bivy nodes add <name> <url> --token …`) — a LAN IP,
Tailscale/VPN name, or an SSH tunnel. An **account node** (one that `bivy nodes`
lists from the control plane) needs no such route: any *online* account node is
reachable over the relay, the same path a phone/PWA uses.

## Why there is no node↔node link

Bivy nodes never connect to each other. A node dials the relay **outbound** and
authenticates as itself; it accepts *clients* (phones, browsers) that join its
room. So "run on another node" is really "**be a client of that node**": the CLI
joins the target's relay room exactly like a browser, and drives its session
protocol. The relay only routes opaque frames; it never holds the room key.

## The handshake

The credential gap ("how does a CLI prove it may pair with a sibling node?") is
closed by the node's own **enrollment token** — no user account session is
needed. This mirrors `src/session/sibling-client.ts` (session replication),
generalized here to an interactive PTY.

```
1. POST {controlPlane}/node/sibling-link-grant  {nodeId}   (Bearer enrollment token)
        → { grant, relayUrl }                 client-scoped, single-use grant
2. POST {controlPlane}/client/relay-ticket      {nodeId}   (Bearer grant)
        → { ticket, relayUrl }                 single-use relay ticket
3. WS   {relay}/client?ticket=…&nodeId=<target>
        ← { t: "ready" }
4. → { t:"pair", p:{ k:"pair.account", sessionToken:<grant>, devicePublicKeyB64, label } }
        node verifies the grant via POST {controlPlane}/node/authorize-client,
        trusts the device, and replies:
   ← { t:"pair", p:{ k:"pair.welcome", nodePublicKeyB64, wrapped } }
5. acceptWelcome() ECDH-unwraps the target's rotating room key.
        All subsequent frames are sealed with it; the relay stays blind.
```

The CLI reuses one persisted device identity (`relay-cli-device.json`, next to
`relay.json`) so repeated runs don't spam the target's device list.

## The bridge (why `attach` needs no relay awareness)

The node speaks **one** `terminal.*` vocabulary. On a local `/ws` socket the
JSON rides raw; over the relay the *identical* JSON is the `data` field of a
sealed, chunked frame. Both ingress paths converge on the same
`handleTerminalMessage` dispatcher in `src/server.ts`.

So `src/relay-attach.ts`, after pairing, stands up a loopback
`ws://127.0.0.1:<port>/ws` and spawns the ordinary `src/attach.ts` against it.
It then translates envelopes only:

```
attach → local /ws : { kind:"terminal.*", … }  ──seal+chunk──▶ relay ──▶ node
node  ──▶ relay ──▶ reassemble+open ──▶ { type:"terminal.*", … } ──▶ local /ws → attach
```

`attach` keeps ownership of the raw TTY, resize, scrollback, and the
`Ctrl-\ Ctrl-\` detach — detaching leaves the daemon-owned PTY running on the
target node, resumable from a phone, the web app, or another terminal.

Crypto/framing are the already-unit-tested core:
`src/relay-cli-crypto.ts` (`acceptWelcome`, `RoomCipher`) and
`src/relay-chunk.ts` (`frameMessages`, `FrameReassembler`). The bridge's
passthrough invariant is pinned by `test/relay-attach-bridge.test.ts`.

## Constraints

- The target must be **online** (control plane reports `online: true`).
- The **command must exist on the target node's PATH** — the CLI sends the
  agent's bare command (`claude`, `codex`, …), not this machine's absolute path.
- `pi` (the built-in native agent) runs only on the local node, because its
  spec points at local runtime files. Use an installed agent for `--node`.
- `--clone` / `--workspace` still apply only to the local node; the remote
  session starts in the target's configured workspace.

## Direct vs relay

`resolveNodeTarget()` (`bin/bivy.mjs`) prefers a direct registry entry
(`{ source:"direct", url, token }`) and otherwise resolves an online account
node to `{ source:"relay", nodeId, name }`. Direct nodes remain lower-latency
and work with no control plane; relay routing needs no inbound ports or
addresses on either side.
