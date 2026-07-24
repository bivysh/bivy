# FAQ — what Bivy is not

The facts below are all individually documented elsewhere in this repo, but
scattered across docs most people don't read end to end. This page exists to
put them in one place, stated plainly, before you build on an assumption
that isn't true. Every claim links to where the behavior actually lives in
source or in a longer doc.

## Is Bivy production-ready / 1.0?

No. Bivy is **0.x software**. The core loop (run an agent locally, reach it
remotely) is solid and used daily, but interfaces and behavior can change
between releases, and it has not had a third-party security audit. See the
[README](../README.md) and [security-model.md § Known limitations for
0.1](security-model.md#known-limitations-for-01).

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
plane + relay stack is **source-available under FSL-1.1-ALv2** and explicitly
unsupported: no uptime, response-time, or data-durability guarantees, and
breaking changes between versions are likely. If you run it, you own
operating it — TLS, backups, restores, secret rotation, monitoring, and
abuse prevention are on you. GitHub issues are community best-effort, not a
guarantee. **Bivy Cloud** is the supported, managed alternative. See
[self-host.md § Maturity & support](self-host.md#maturity-support) and
[CLOUD.md](../CLOUD.md).

(Bivy Core — the node + CLI running locally with no hosted account — is a
different thing and is not what this answer is about; that's the normal,
supported way to run Bivy.)

## Does the control plane see my GitHub issue text?

Yes, in plaintext, for the GitHub work queue specifically. When a labeled
issue or `@`-mention comment triggers a work item, the control plane stores
that item's repository slug, issue number/URL, routing label, status — and
the **issue title and body**, unencrypted, in its Postgres `work_items` table
(`services/control-plane/src/postgres-store.ts`). That's true for as long as
the item exists — at minimum while it's sitting pending and unclaimed, and
the row isn't automatically cleared or encrypted once a node claims it either;
it stays until you delete it yourself (`DELETE /account/work-items/:id`). If
your issue titles/bodies are sensitive, don't route them through the hosted
work queue. Repository contents, diffs, and agent output are a different
story — those never leave your node. See [security-model.md § Known
limitations for 0.1, item
5](security-model.md#known-limitations-for-01) and
[github-work-queue.md § Privacy and security
model](github-work-queue.md#privacy-and-security-model).

## Are push notification contents private from the control plane?

No. To render a phone notification, the node sends the notification's
**title and body in plaintext** to the control plane
(`POST /internal/notifications/hints`), which relays it on to the browser's
push service via Web Push. That text can include a session or terminal name.
Everything else about a session — prompts, tool output, terminal I/O, file
contents — stays end-to-end encrypted between your node and your clients; push
notification text is the one documented exception. See
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

Something on this list surprised you, or you found another Bivy-is-not-X
assumption worth adding here? Open an issue — this page is meant to grow as
gaps get found, not stay a fixed list.
