# Tailscale: one machine, no server

Reach the agents on your own machine from your phone or laptop, anywhere, with
nothing of Bivy's in between: no account, no control plane, no relay. Tailscale
connects your devices; the node serves the web app itself.

```bash
bivy tailscale
```

That's it. It prints `https://<machine>.<tailnet>.ts.net` and a one-time pairing
link (with a QR code). Open the link on your phone, add the page to your home
screen, and you're in.

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
4. Prints a pairing link.

The setting survives restarts: the node reopens the listener at boot, and
`tailscale serve --bg` persists on Tailscale's side.

| Command | |
|---|---|
| `bivy tailscale` | Turn it on (again) and pair a device |
| `bivy tailscale pair` | A new pairing link for another device |
| `bivy tailscale status` | Address and port |
| `bivy tailscale devices` | Devices holding a token for this node |
| `bivy tailscale revoke <id>` | Revoke a token; its open connections close at once |
| `bivy tailscale off` | Stop serving and close the listener |

## Security

- **Tailnet only.** `bivy tailscale` refuses to run when Tailscale Funnel is on
  for the machine's HTTPS name, since that would put Bivy on the public
  internet. It also won't replace another app's `tailscale serve` on port 443.
- **Every request needs a device token.** `tailscale serve` forwards from
  127.0.0.1, so connections look local. The direct listener marks each of its
  connections as remote, so the loopback bypass, `/api/auth/bootstrap` and
  `/api/git-credential` never apply to them.
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
attachments, agent and model settings, all on the one machine you paired with.

Not yet over a direct connection:

- **Several machines in one app.** The web app shows the machine that served
  it. Open each machine's own address, or use the relay setup
  ([remote access](remote-access.md)) to see all of them in one place.
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
