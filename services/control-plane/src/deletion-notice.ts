// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The one notice Core sends on the fleet's behalf: a cloud machine has been
// idle long enough that it and its disk are about to be deleted. Core owns the
// relationship with the person — their address, their devices, their mute
// preferences — so the fleet asks for the notice instead of sending it.
//
// Waking the machine resets the clock; the copy says so.

export interface DeletionNotice {
  kind: "computer" | "runner";
  deleteAt: string;
  appUrl: string;
  supportEmail: string;
}

export interface EmailContent { subject: string; text: string; html: string }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const day = (deleteAt: string) => new Date(deleteAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/** One row per kind, so the subject, the body and the push text can't drift. */
const COPY: Record<DeletionNotice["kind"], (on: string) => { subject: string; lines: string[] }> = {
  computer: (on) => ({
    subject: `Your Bivy cloud computer will be deleted on ${on}`,
    lines: [
      `Your Bivy cloud computer hasn't been used for a while. On ${on} we'll delete it, including its disk: workspaces, uncommitted changes, installed tools and agent sign-ins.`,
      "To keep it, open Bivy and send a message in any session on it. That wakes it and resets the clock.",
      "Anything you've pushed to GitHub is safe either way.",
    ],
  }),
  runner: (on) => ({
    subject: `A sleeping Bivy runner will be deleted on ${on}`,
    lines: [
      `A session you ran on a Bivy runner has been asleep for a while. On ${on} we'll delete that runner, including its disk and the session on it: the conversation, its workspace and any uncommitted changes.`,
      "To keep it, open the session in Bivy and send a message. That wakes the runner and resets the clock.",
      "Anything you've pushed to GitHub is safe either way.",
    ],
  }),
};

export function deletionNoticeEmail({ kind, deleteAt, appUrl, supportEmail }: DeletionNotice): EmailContent {
  const { subject, lines } = COPY[kind](day(deleteAt));
  const text = [...lines.flatMap((line) => [line, ""]), `Open Bivy: ${appUrl}`, "", `Questions? Reply to this email or write to ${supportEmail}.`].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;line-height:1.55">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px 28px">
${lines.map((line) => `<p style="margin:0 0 16px">${e(line)}</p>`).join("\n")}
<p style="margin:0 0 16px"><a href="${e(appUrl)}" style="color:#2b6cb0">Open Bivy</a></p>
<p style="margin:0;color:#57534e">Questions? Reply to this email or write to <a href="mailto:${e(supportEmail)}" style="color:#2b6cb0">${e(supportEmail)}</a>.</p>
</div></body></html>`;
  return { subject, text, html };
}

/** The short form for a device notification. */
export function deletionNoticePush(notice: DeletionNotice): { kind: string; title: string; body: string } {
  const { subject, lines } = COPY[notice.kind](day(notice.deleteAt));
  return { kind: "machine-deletion", title: subject, body: lines[1]! };
}
