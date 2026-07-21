// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { isStandaloneDisplay, startGithubDeviceLogin, pollDeviceLogin } from "@bivy/core";
import { controller } from "../store/useStore.js";

/**
 * Shown on the hosted control plane (app.bivy.sh) before the client is signed
 * in. Offers GitHub OAuth and email magic-link sign-in. Once signed in, the app
 * shell renders and a node is picked from the header NodeSwitcher.
 *
 * GitHub sign-in uses one of two flows:
 *  - Browser tab: a full-page redirect to /auth/github/start; the callback
 *    returns the session token in the URL fragment, captured on boot.
 *  - Installed PWA / home-screen app: a redirect would leave the app's manifest
 *    scope (github.com, then a control-plane URL outside scope), so the browser
 *    hands OAuth to the system browser and the finished session never returns to
 *    the installed window. Instead we open GitHub in a browser tab and poll the
 *    device-login endpoint — the app window stays put and stays connected.
 */
export function SetupNotice() {
  const origin = location.origin;
  const [email, setEmail] = useState("");
  const [note, setNote] = useState<{ text: string; href?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  // The authorize URL, once known, so it can render as a real clickable link —
  // the guaranteed fallback when neither window.open() attempt below actually
  // showed the user a tab (popup blockers, Safari's user-gesture timeout across
  // the `await`, etc. — none of that is reliably detectable, so instead of
  // trying to detect it, always give the user a manual way out).
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  // Non-standalone (browser-tab) sign-in is a real full-page navigation, so
  // there's no busy state to track the round trip — but the click-to-actual-
  // navigation gap can still be a second or two with zero feedback. This just
  // covers that gap.
  const [redirecting, setRedirecting] = useState(false);
  // Cancel any in-flight device poll — on unmount, or via the Cancel button.
  // A plain boolean (not tied to unmount) so a cancelled attempt can be
  // retried: pollCancelled only ever transitions to `true`, so it can't be
  // reused across a second `githubDeviceSignIn()` call, but this ref is reset
  // at the start of each attempt.
  const cancelled = useRef(false);
  useEffect(() => () => void (cancelled.current = true), []);

  function cancelGithubSignIn() {
    cancelled.current = true;
    setGithubBusy(false);
    setGithubError(null);
    setAuthorizeUrl(null);
  }

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value || sending) return;
    setSending(true);
    setNote({ text: "Sending…" });
    try {
      const res = await fetch(`${origin}/auth/magic-link/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Could not send sign-in link.");
      if (data?.devLink) setNote({ text: "Dev link:", href: data.devLink });
      else setNote({ text: "Check your email for a sign-in link." });
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : "Could not send sign-in link." });
    } finally {
      setSending(false);
    }
  }

  // Installed-app GitHub sign-in: open OAuth in a browser tab, poll for the
  // session, then store the token and reload into the signed-in state.
  async function githubDeviceSignIn() {
    if (githubBusy) return;
    setGithubError(null);
    setGithubBusy(true);
    setAuthorizeUrl(null);
    cancelled.current = false;
    // Open the tab synchronously inside the click handler so it isn't treated as
    // a blocked pop-up; navigate it to the authorize URL once we have it.
    const tab = window.open("", "_blank");
    try {
      const login = await startGithubDeviceLogin(controller.local);
      // Render a real link regardless of whether `tab`/the fallback open()
      // below actually got a visible window — a popup blocker (or Safari
      // treating the user gesture as stale after the `await` above) leaves no
      // reliable signal to detect, so don't try; always give a manual escape
      // hatch instead of trusting window.open() silently worked.
      setAuthorizeUrl(login.authorizeUrl);
      if (tab) tab.location.href = login.authorizeUrl;
      else window.open(login.authorizeUrl, "_blank", "noopener");

      const deadline = Date.now() + login.expiresInMs;
      while (!cancelled.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, login.intervalMs));
        if (cancelled.current) return;
        const result = await pollDeviceLogin(controller.local, login.deviceId, login.deviceSecret);
        if (result.status === "complete") {
          try { tab?.close(); } catch { /* cross-origin tab: leave it */ }
          // Transition in place instead of location.reload(): an installed PWA
          // returning from the OAuth hand-off doesn't reliably reload, which left
          // the token stored but the window stuck on this sign-in screen until a
          // manual close+reopen. completeSignIn flips the reactive auth state and
          // dials the node without navigating.
          controller.completeSignIn(result.token);
          return;
        }
        if (result.status === "expired" || result.status === "error") {
          throw new Error(result.error || "Sign-in expired. Please try again.");
        }
      }
      if (!cancelled.current) throw new Error("Sign-in timed out. Please try again.");
    } catch (err) {
      try { tab?.close(); } catch { /* ignore */ }
      if (!cancelled.current) setGithubError(err instanceof Error ? err.message : "GitHub sign-in failed.");
    } finally {
      if (!cancelled.current) { setGithubBusy(false); setAuthorizeUrl(null); }
    }
  }

  const standalone = isStandaloneDisplay();

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-glyph">⛺</div>
        <h1>Bivy</h1>
        <p>Sign in to reach your coding agents from anywhere.</p>
        {standalone ? (
          <button
            type="button"
            className="btn primary block"
            onClick={githubDeviceSignIn}
            disabled={githubBusy}
          >
            {githubBusy ? "Waiting for GitHub…" : "Sign in with GitHub"}
          </button>
        ) : (
          // Land the OAuth callback back on this client's own path so a sign-in
          // started from a sub-path returns there rather than defaulting to root.
          <a
            className="btn primary block"
            href={`${origin}/auth/github/start?return=${encodeURIComponent(location.pathname)}`}
            onClick={() => setRedirecting(true)}
          >
            {redirecting ? "Redirecting…" : "Sign in with GitHub"}
          </a>
        )}
        {githubBusy && (
          <div className="setup-note muted">
            <p>Finish signing in on the GitHub tab, then return here — this completes automatically.</p>
            {authorizeUrl && (
              <p>
                Tab didn't open?{" "}
                <a href={authorizeUrl} target="_blank" rel="noopener">
                  Open GitHub sign-in
                </a>
              </p>
            )}
            <button type="button" className="link-btn" onClick={cancelGithubSignIn}>
              Cancel
            </button>
          </div>
        )}
        {githubError && <p className="setup-note muted">{githubError}</p>}
        <div className="setup-or">or with email</div>
        <form className="setup-email" onSubmit={sendMagicLink}>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button className="btn" type="submit" disabled={sending || !email.trim()}>
            Email me a link
          </button>
        </form>
        {note && (
          <p className="setup-note muted">
            {note.text}{" "}
            {note.href && (
              <a href={note.href}>{note.href}</a>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
