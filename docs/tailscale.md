# Tailscale: your machines, no server

Reach the agents on your own machines from your phone or laptop, anywhere, with
nothing of Bivy's in between: no account, no control plane, no relay. Tailscale
connects your devices; each machine serves the web app itself.

It covers the core of Bivy: sessions, chat, approvals, questions, terminals and
files. Push notifications and app previews need [Bivy hosted or your own
server](remote-access.md); see [what works](#what-works-and-what-doesnt-yet).

```bash
bivy tailscale
```

That's it. It prints `https://<machine>.<tailnet>.ts.net`. Open it on your
phone, add the page to your home screen, and you're in. Your own devices (signed
in to Tailscale as you) need no pairing. Someone else's device on your tailnet
pairs once with a link from `bivy tailscale pair`.

Run `bivy tailscale` on each of your machines and they show up together: the
machine menu at the top of the app lists every machine on your tailnet running
Bivy, and picking one opens it.

## Before you start

- Tailscale is installed and signed in on the machine and on each device you
  want to use (`sudo tailscale up`).
- **HTTPS certificates** are on for your tailnet (admin console → DNS → HTTPS
  Certificates). Installing the web app, its service worker and the microphone
  all need a real HTTPS address.
- On Linux, your user may manage Tailscale:
  `sudo tailscale set --operator=$USER` (once).

## What it does

1. Picks a free loopback port (by default the node's port + 2) and writes it,
   with the machine's tailnet name, to `<data-dir>/tailscale.json`.
2. The node opens its **direct listener** on that port: the same API and
   WebSocket as the main port, plus the built web app.
3. Runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>`. Tailscale
   terminates TLS with a certificate for the machine's name and forwards to the
   listener. Only devices on your tailnet can reach it.
4. Records your Tailscale login as the machine's owner, so your devices get in
   without pairing. On a tagged machine (owned by tags, not a person) every
   device pairs instead, and it prints a pairing link.

The setting survives restarts: the node reopens the listener at boot, and
`tailscale serve --bg` persists on Tailscale's side.

| Command | |
|---|---|
| `bivy tailscale` | Turn it on (again) |
| `bivy tailscale pair` | A pairing link for someone else's device |
| `bivy tailscale status` | Address and port |
| `bivy tailscale devices` | Devices holding a token for this node |
| `bivy tailscale revoke <id>` | Revoke a token; its open connections close at once |
| `bivy tailscale off` | Stop serving and close the listener |

## Security

- **Tailnet only.** `bivy tailscale` refuses to run when Tailscale Funnel is on
  for the machine's HTTPS name, since that would put Bivy on the public
  internet. It also won't replace another app's `tailscale serve` on port 443.
- **Every request needs your Tailscale identity or a device token.**
  `tailscale serve` forwards from 127.0.0.1, so connections look local. The
  direct listener marks each of its connections as remote, so the loopback
  bypass, `/api/auth/bootstrap` and `/api/git-credential` never apply to them.
- **Your identity comes from Tailscale.** On traffic from your tailnet,
  `tailscale serve` sets `Tailscale-User-Login` to the requester's login and
  removes any value a client sends. A request carrying the owner's login is let
  in without a token. Tagged devices and Funnel traffic carry no identity. The
  listener binds loopback, so on a machine with several user accounts (or with
  `BIVY_REQUIRE_LOCAL_AUTH=1`) the header is ignored and every device pairs.
- **Discovery** asks each online tailnet peer for `/api/direct/hello`, which
  says only that Bivy runs there and under which name.
- **Pairing codes** are 192-bit, single-use and valid for 10 minutes. They live
  only in the node's memory, so a restart voids any that are outstanding. The
  code travels in the URL fragment, which the browser does not send in
  requests, and the app removes it from the address bar once read. Redeeming
  one is rate-limited.
- Only callers the node already trusts can mint a code: your CLI on the machine,
  or a device that is already paired. Agent session tokens can't.
- Tailscale encrypts traffic between your devices (WireGuard). Tailscale's
  coordination server sees which devices are in your tailnet, not what they
  send. Run [Headscale](https://github.com/juanfont/headscale) if you want to host
  that part as well.

## What works, and what doesn't yet

Works: sessions, live transcripts, approvals, questions, terminals, files and
attachments, agent and model settings, and switching between your tailnet's
machines from the machine menu.

Not yet over a direct connection:

- **One list across machines.** Each machine shows its own sessions; the machine
  menu switches between them (each at its own address). The relay setup
  ([remote access](remote-access.md)) shows every machine's sessions together.
- **Push notifications.** They need a push subscription registered with a
  control plane today.
- **App previews and share links.** Previews give each app its own origin,
  which needs wildcard subdomains. A tailnet name is a single host. You can
  point a wildcard domain you own at the machine's Tailscale IP and set
  `BIVY_APPS_ORIGIN` ([apps](apps.md)); share links need a public URL.

## Turning it off

```bash
bivy tailscale off
```

This removes Bivy's `tailscale serve` entry and closes the listener. Paired
devices keep their tokens until you revoke them with
`bivy tailscale revoke <id>`.
