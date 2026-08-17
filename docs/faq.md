# FAQ — what Bivy is not

The facts below are all documented elsewhere in this repo, but scattered across
several docs. This page collects them in one place, stated plainly, so you don't
build on an assumption that isn't true. Every claim links to where the behavior
lives in source or in a longer doc.

## Is Bivy production-ready / 1.0?

No. Bivy is **0.x software**. The core loop (run an agent locally, reach it
remotely) is solid and used daily, but interfaces and behavior can change
between releases, and it has not had a third-party security audit. See the
[README](../README.md) and [security-model.md § Known limitations for
0.x](security-model.md#known-limitations-for-0x).

## Is there an Electron desktop app?

No. There is no Electron (or other native-shell) desktop build. The node has
no UI at all — it's a background daemon plus a CLI. When you do want a
graphical/remote UI, it's the React/Vite **web app**, served by a control
plane (hosted or self-hosted) and installable as a PWA. See
[remote-access.md](remote-access.md) and the architecture diagram in the
[README](../README.md#architecture).

## Is there a native mobile app (App Store / Play Store)?

No. There is no native iOS or Android binary. The phone client is the same
installable **PWA** as the desktop web client — add it to your home screen
from Safari/Chrome and it behaves like an app (standalone display, offline
shell, push notifications), but it ships no app-store binary and needs no
app-store install. See [remote-access.md § Install the
PWA](remote-access.md#4-install-the-pwa).

## Can I get support for a self-hosted deployment?

No, not in the sense of an SLA or a support queue. Self-hosting the control
plane + relay stack is **open-source under AGPL-3.0-only** and explicitly
unsupported: no uptime, response-time, or data-durability guarantees, and
breaking changes between versions are likely. If you run it, you own
operating it — TLS, backups, restores, secret rotation, monitoring, and
abuse prevention are on you. GitHub issues are community best-effort, not a
guarantee. **Bivy Cloud** is the supported, managed alternative. See
[self-host.md § Maturity and support](self-host.md#maturity-and-support).

(Bivy Core — the node + CLI running locally with no hosted account — is a
different thing and is not what this answer is about; that's the normal,
supported way to run Bivy.)

## Does the control plane see my GitHub issue text?

It receives the signed GitHub webhook delivery in order to verify and route the
event, but it does **not retain** the issue or comment title/body. The queued row
contains routing metadata only: repository slug, issue number/URL, target label,
status, and timestamps. Immediately before work starts, the claiming node fetches
the current issue or comment directly from GitHub using its local credential.
Repository contents, diffs, prompts, transcripts, and agent output also remain on
the node. See [github-work-queue.md § Privacy and security
model](github-work-queue.md#privacy-and-security-model).

## Does the control plane see Slack or generic webhook instructions?

Yes. Those sources call the control plane directly rather than sending an
end-to-end-encrypted session frame. A Slack command's prompt is retained as the
queued run title; a generic webhook's fixed template and event instruction are
retained as the run body until the run is deleted. Do not include secrets in
those instructions. GitHub and Linear are different: the control plane keeps
identifiers and routing metadata, while the node fetches current issue text
directly from the provider. Interactive terminal/browser/phone prompts remain
end-to-end encrypted. See [security-model.md § What the control plane
sees](security-model.md#what-the-control-plane-sees).

## Are push notification contents private from the control plane?

No. To render a phone notification, the node sends the notification's
**title and body in plaintext** to the control plane
(`POST /internal/notifications/hints`), which relays it on to the browser's
push service via Web Push. That text can include a session or terminal name.
The underlying interactive session — prompts, tool output, terminal I/O, file
contents — stays end-to-end encrypted between your node and your clients. See
[remote-access.md § Security model](remote-access.md#security-model).

## Does Bivy pause for my approval before risky actions by default?

No. The default approval mode is **`autonomous`** — sessions run without
per-action approval prompts. Safety in this mode comes from a separate,
always-on hard-floor deny list (catastrophic commands and writes outside the
workspace are blocked in every mode) plus a small backstop set (force-push,
publish, deploy, `sudo`) that still pauses regardless of mode — not from
asking before every risky-looking command. If you want prompt-heavy behavior,
set `BIVY_APPROVAL_MODE=risky` or `always`. See
[configuration.md](configuration.md) for the full approval-mode reference.

---

Found another Bivy-is-not-X assumption worth adding here? Open an issue so it
can be added.
