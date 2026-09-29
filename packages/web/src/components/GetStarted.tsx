// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The first thing a new user sees once setup passes: one tap hands the agent a
// short "show me around" request. The agent does the onboarding — it looks at
// the workspace, proposes first tasks that fit it, and teaches the one idea
// that matters (it keeps working while you're away) at the moment it's true.
// Plain text in the user's voice, so it works with any agent, and it's visible
// in the transcript so nothing happens behind the user's back. It only shows
// while the account has no sessions, so it naturally runs once.

/** Sent as the user's first message. Keep it short: the user reads it too. */
export const GET_STARTED_PROMPT = [
  "I'm new to Bivy. Show me around:",
  "1. Take a quick look at this workspace (a minute, not an audit) and tell me in two or three sentences what's here.",
  "2. Suggest three first tasks you could do for me here: small enough to finish in a few minutes, " +
    "useful enough that I'd keep the result (not chores like running the tests). Make at least one something I can see, with a live preview I can open " +
    "on my phone. If the workspace is empty, suggest small things to build from scratch. Post each with `bivy suggest` " +
    "so I can start it in one tap (if you can't run it, list them).",
  "3. Then stop and let me pick. Don't change any files until I do.",
  "Keep this reply short; I may be on my phone. Later, only once that first task is finished, show me the result " +
    "and add one line: next time I can close the app while you work, and Bivy can notify me when you're done " +
    "(Settings → Notifications).",
].join("\n");

export function GetStarted({ machineName, onStart }: { machineName?: string; onStart: () => void }) {
  return (
    <section className="card readiness" aria-labelledby="get-started-title">
      <p className="readiness-passed" role="status">✓ Setup complete</p>
      <h2 id="get-started-title" className="card-title">Let your agent show you around</h2>
      <p className="card-sub">
        It runs on {machineName || "your machine"} and keeps working when you close this app.
        It'll look at your workspace and suggest a few first tasks.
      </p>
      <div className="get-started-actions">
        <button type="button" className="btn sm primary" onClick={onStart}>Show me around</button>
        <span className="card-sub">or type your own task below</span>
      </div>
    </section>
  );
}
