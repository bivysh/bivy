// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The first thing a new user sees once setup passes: one tap starts the loop
// Bivy is for. The agent works, the result reaches the phone, the user marks
// or answers, and it ships. If a dev server is already running on the machine,
// the first task is that app: the agent publishes it, it opens, the user marks
// what's wrong, and gets a fix and a share link. Otherwise the agent makes one small change and reports back by push.
// Both are plain text in the user's voice, so they work with any agent and are
// visible in the transcript. It only shows while the account has no sessions.

import { useEffect, useState } from "react";
import type { AppOffer, SessionAppOffersResult } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Spinner } from "./Spinner.js";

/** A detected server's app, named for the folder it runs in. */
export type FirstApp = AppOffer & { project: string };

/** Sent when the user opens a running app. The agent publishes it from the
 *  folder it works in (a checkout's session gets a worktree, which the running
 *  server doesn't serve), then waits for their marks. */
export function openAppPrompt(app: FirstApp): string {
  return [
    `I'm new to Bivy. My app runs with \`${app.command}\` on port ${app.port}; I want to open it in a preview and mark what's wrong.`,
    "Publish it with `bivy app publish` so the preview shows your edits: if you're working in the folder it already runs in, " +
      `publish port ${app.port}; otherwise have Bivy run it from your folder on a free port (a "start" command in the manifest).`,
    "Don't change anything else yet; once it's published, reply in one short line that it's ready.",
    "When my marks arrive, fix them and check your fix. Then make a share link with `bivy app share` " +
      "and reply with it.",
  ].join("\n");
}

/** Sent when nothing is running: one small change, reported back in one line. */
export const FIRST_CHANGE_PROMPT = [
  "I'm new to Bivy. Make one small, useful change in this workspace that I'd keep: a few minutes of work, " +
    "not a chore like running the tests. If the workspace is empty, build something small I can open.",
  "Pick it yourself. If you really need a decision from me, ask with `bivy ask`.",
  "If it's something I can see, run it and publish a preview with `bivy app publish`.",
  "Finish with the result in one line. Keep replies short, I'm probably on my phone.",
].join("\n");

/** How long to wait for the machine's list of running servers before offering the other path. */
const SCAN_MS = 4000;

const projectName = (project: string) => project.split(/[\\/]/).filter(Boolean).pop() || project;

export function GetStarted({ machineName, onOpenApp, onFirstChange }: {
  machineName?: string;
  onOpenApp: (app: FirstApp) => void;
  onFirstChange: () => void;
}) {
  const machine = machineName || "your machine";
  // Servers on the machine, before any session exists. Older machines answer
  // with an error, which is the same as finding none.
  const [apps, setApps] = useState<FirstApp[] | null>(null);
  const [pushEligible, setPushEligible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const none = setTimeout(() => { if (live) setApps((found) => found ?? []); }, SCAN_MS);
    controller.appCommand("apps.offers", undefined).then((event) => {
      const offers = (event as unknown as SessionAppOffersResult).offers ?? [];
      // A late answer doesn't swap the card under someone's thumb.
      if (live) setApps((found) => found ?? offers.filter((offer): offer is FirstApp => typeof offer.project === "string"));
    }, () => { if (live) setApps([]); });
    // Asked up front, so the tap can request permission while it still counts as a gesture.
    if (!controller.direct) controller.pushStatus().then((status) => {
      if (live) setPushEligible(status.supported && !status.subscribed && status.permission !== "denied");
    }, () => {});
    return () => { live = false; clearTimeout(none); };
  }, []);

  /** The loop ends on the phone, so the first task turns on notifications for
   *  this device first. Declining still starts the task. */
  const start = async (go: () => void) => {
    setBusy(true);
    if (pushEligible) await controller.enablePush().catch(() => {});
    go();
  };

  const [first, ...more] = apps ?? [];
  return (
    <section className="card readiness" aria-labelledby="get-started-title" aria-busy={apps === null}>
      <p className="readiness-passed" role="status">✓ Setup complete</p>
      {apps === null ? <>
        <h2 id="get-started-title" className="card-title">Your agent's first task</h2>
        <p className="card-sub get-started-scan" role="status"><Spinner size="xs" />Looking for apps running on {machine}…</p>
      </> : first ? <>
        <h2 id="get-started-title" className="card-title">Mark what's wrong in {projectName(first.project)}</h2>
        <p className="card-sub">
          It's running on {machine}. The agent opens it here, you tap what's off, and it fixes it and
          sends you a link to share. It keeps working when you close this app.
        </p>
        <p className="get-started-app card-sub"><code>{first.command}</code> · port {first.port}</p>
        <div className="get-started-actions">
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void start(() => onOpenApp(first))}>
            Open {projectName(first.project)} and mark what's wrong
          </button>
          <span className="card-sub">or type your own task below</span>
        </div>
        {more.length > 0 && <div className="get-started-more" role="group" aria-label="Other running apps">
          <span className="card-sub">Also running:</span>
          {more.slice(0, 3).map((app) => <button key={app.port} type="button" className="btn sm ghost" disabled={busy}
            onClick={() => void start(() => onOpenApp(app))} aria-label={`Open ${projectName(app.project)} on port ${app.port} and mark what's wrong`}>
            {projectName(app.project)} · {app.port}
          </button>)}
        </div>}
      </> : <>
        <h2 id="get-started-title" className="card-title">Give your agent a first task</h2>
        <p className="card-sub">
          It runs on {machine} and keeps working when you close this app. It'll make one small,
          useful change here and tell your phone when it's done.
        </p>
        <div className="get-started-actions">
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void start(onFirstChange)}>Make one small improvement</button>
          <span className="card-sub">or type your own task below</span>
        </div>
      </>}
    </section>
  );
}
