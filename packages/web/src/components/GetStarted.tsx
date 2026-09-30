// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The first thing a new user sees once setup passes: one tap starts the loop
// Bivy is for. The agent works, the result reaches the phone, the user marks
// or answers, and it ships. If a dev server is already running on the machine,
// the first task is that app: open it, mark what's wrong, get a fix and a share
// link. Otherwise the agent makes one small change and reports back by push.
// Both are plain text in the user's voice, so they work with any agent and are
// visible in the transcript. It only shows while the account has no sessions.

import { useEffect, useState } from "react";
import type { AppOffer, SessionAppOffersResult } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Spinner } from "./Spinner.js";

/** A detected server's app, named for the folder it runs in. */
export type FirstApp = AppOffer & { project: string };

/** Sent when the user opens a running app. The agent waits for their marks. */
export function openAppPrompt(app: FirstApp): string {
  return [
    `I'm new to Bivy. I'm opening my app (\`${app.command}\` on port ${app.port}) in a preview to mark what's wrong.`,
    "Don't change anything yet; reply in one short line that you're ready.",
    "When my marks arrive, fix them and check your fix. Then make a share link with `bivy app share` " +
      "and send it to me with `bivy notify`, so it reaches my phone if I've closed the app.",
  ].join("\n");
}

/** Sent when nothing is running: one small change, reported back by push. */
export const FIRST_CHANGE_PROMPT = [
  "I'm new to Bivy. Make one small, useful change in this workspace that I'd keep: a few minutes of work, " +
    "not a chore like running the tests. If the workspace is empty, build something small I can open.",
  "Pick it yourself. If you really need a decision from me, ask with `bivy ask`.",
  "If it's something I can see, run it and publish a preview with `bivy app publish`.",
  "Last step, always: send me the result in one line with `bivy notify`, since I may have closed the app. Keep replies short, I'm probably on my phone.",
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
          It's running on {machine}. Open it here, tap what's off, and the agent fixes it and sends you
          a link to share. It keeps working when you close this app.
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
