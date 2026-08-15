// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { isStandaloneDisplay, startGithubDeviceLogin, startEmailDeviceLogin, pollDeviceLogin, type EmailDeviceLogin } from "@bivy/core";
import { controller } from "../store/useStore.js";

/**
 * Shown on the hosted control plane (app.bivy.sh) before the client is signed
 * in. Offers GitHub OAuth and email magic-link sign-in. Once signed in, the app
 * shell renders and a node is picked from the header NodeSwitcher.
 *
 * Both GitHub and email sign-in use one of two flows, chosen by display mode:
 *  - Browser tab: GitHub is a full-page redirect to /auth/github/start and email
 *    is the redirect-based magic link (/auth/magic-link/start); the callback
 *    returns the session token in the URL fragment, captured on boot.
 *  - Installed PWA / home-screen app: a redirect (or an emailed link) opens in
 *    the system browser, outside the app's manifest scope, so the finished
 *    session never returns to the installed window. Instead we start a device
 *    login (GitHub tab, or an emailed link) and poll the device endpoint — the
 *    app window stays put and finishes sign-in in place.
 */
export function SetupNotice() {
  const origin = location.origin;
  // An installed/home-screen PWA runs in a scoped window; an emailed magic link
  // opens in the system browser, not this window, so the redirect-based sign-in
  // would finish in that browser tab and never return here. Detect standalone so
  // both GitHub and email sign-in fall back to the device-poll flow, which keeps
  // the app window put and completes in place. See isStandaloneDisplay().
  const standalone = isStandaloneDisplay();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState<{ text: string; href?: string } | null>(null);
  const [sending, setSending] = useState(false);
  // The address a magic link was last sent to, so we can offer an explicit
  // "resend" instead of leaving the user on a static "check your email" message
  // with no recourse if it never arrives.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  // A failure bounced back from the OAuth callback (?authError=<code>), e.g. a
  // GitHub account with no verified email. Shown prominently so the user lands
  // on the sign-in card with a clear reason and a path forward, not a dead-end
  // error page from the callback.
  const [signInError, setSignInError] = useState<string | null>(null);
  useEffect(() => {
    let code = "";
    try {
      const params = new URLSearchParams(location.search);
      code = (params.get("authError") || "").trim();
      if (code) {
        params.delete("authError");
        const qs = params.toString();
        history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
      }
    } catch {
      /* ignore malformed query */
    }
    if (!code) return;
    const messages: Record<string, string> = {
      "github-email":
        "GitHub didn't share a verified email, so we couldn't sign you in. Add and verify an email on your GitHub account, or use email sign-in below.",
      "github-config": "Couldn't complete GitHub sign-in due to a server issue. Please try again in a moment.",
      expired: "That sign-in request was invalid or expired. Please try again.",
    };
    setSignInError(messages[code] || "Sign-in failed. Please try again.");
  }, []);
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
  // Standalone email sign-in polls in the background after the link is sent, for
  // as long as the link stays valid. Each attempt owns its own cancel token so a
  // resend cleanly stops the previous poll loop instead of two loops racing on a
  // single shared flag. `emailWaiting` drives the "waiting for the link" UI.
  const [emailWaiting, setEmailWaiting] = useState(false);
  const emailPoll = useRef<{ cancelled: boolean } | null>(null);
  useEffect(
    () => () => {
      cancelled.current = true;
      if (emailPoll.current) emailPoll.current.cancelled = true;
    },
    [],
  );

  function cancelGithubSignIn() {
    cancelled.current = true;
    setGithubBusy(false);
    setGithubError(null);
    setAuthorizeUrl(null);
  }

  function cancelEmailSignIn() {
    if (emailPoll.current) emailPoll.current.cancelled = true;
    emailPoll.current = null;
    setEmailWaiting(false);
    setNote(null);
    setSentTo(null);
  }

  // Poll for a standalone email device-login to complete, then finish sign-in in
  // place (no navigation). Owns its cancel token so a superseding attempt or an
  // unmount stops exactly this loop.
  async function pollEmailDeviceLogin(login: EmailDeviceLogin, token: { cancelled: boolean }) {
    const deadline = Date.now() + login.expiresInMs;
    try {
      while (!token.cancelled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, login.intervalMs));
        if (token.cancelled) return;
        const result = await pollDeviceLogin(controller.local, login.deviceId, login.deviceSecret);
        if (token.cancelled) return;
        if (result.status === "complete") {
          controller.completeSignIn(result.token);
          return;
        }
        if (result.status === "expired" || result.status === "error") {
          throw new Error(result.error || "That sign-in link expired. Please request a new one.");
        }
      }
      if (!token.cancelled) throw new Error("Sign-in timed out. Please request a new link.");
    } catch (err) {
      if (!token.cancelled) {
        setSignInError(err instanceof Error ? err.message : "Sign-in failed.");
        setEmailWaiting(false);
      }
    } finally {
      if (emailPoll.current === token) emailPoll.current = null;
    }
  }

  async function requestMagicLink(value: string) {
    if (!value || sending) return;
    setSignInError(null);
    setSending(true);
    setNote({ text: "Sending…" });
    try {
      // Installed PWA: an emailed link opens in the system browser, not this
      // window, so use the device flow — send the link, then poll here and finish
      // in place so the installed window becomes the signed-in app. See
      // startEmailDeviceLogin / the GitHub device flow below.
      if (standalone) {
        // Supersede any previous attempt's poll so a resend doesn't leave two loops.
        if (emailPoll.current) emailPoll.current.cancelled = true;
        const login = await startEmailDeviceLogin(controller.local, value);
        if (login.devLink) {
          setNote({ text: "Dev link:", href: login.devLink });
        } else {
          setNote({ text: `Check your email — we sent a sign-in link to ${value}. Open it on this device and you'll be signed in here automatically.` });
        }
        setSentTo(value);
        setEmailWaiting(true);
        const token = { cancelled: false };
        emailPoll.current = token;
        void pollEmailDeviceLogin(login, token);
        return;
      }
      const res = await fetch(`${origin}/auth/magic-link/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Could not send sign-in link.");
      if (data?.devLink) {
        setNote({ text: "Dev link:", href: data.devLink });
      } else {
        setNote({ text: `Check your email — we sent a sign-in link to ${value}.` });
      }
      setSentTo(value);
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : "Could not send sign-in link." });
      setSentTo(null);
      setEmailWaiting(false);
    } finally {
      setSending(false);
    }
  }

  function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    void requestMagicLink(email.trim());
  }

  // Installed-app GitHub sign-in: open OAuth in a browser tab, poll for the
  // session, then store the token and reload into the signed-in state.
  async function githubDeviceSignIn() {
    if (githubBusy) return;
    setGithubError(null);
    setSignInError(null);
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

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-glyph">⛺</div>
        <h1>Bivy</h1>
        <p>Sign in or create an account, then connect a machine or launch your first cloud runner.</p>
        {signInError && (
          <div className="setup-error" role="alert">
            {signInError}
          </div>
        )}
        {standalone ? (
          <button
            type="button"
            className="btn primary block"
            onClick={githubDeviceSignIn}
            disabled={githubBusy}
          >
            {githubBusy ? "Waiting for GitHub…" : "Continue with GitHub"}
          </button>
        ) : (
          // Land the OAuth callback back on this client's own path so a sign-in
          // started from a sub-path returns there rather than defaulting to root.
          <a
            className="btn primary block"
            href={`${origin}/auth/github/start?return=${encodeURIComponent(location.pathname)}`}
            onClick={() => { setSignInError(null); setRedirecting(true); }}
          >
            {redirecting ? "Redirecting…" : "Continue with GitHub"}
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
            <button type="button" className="btn link" onClick={cancelGithubSignIn}>
              Cancel
            </button>
          </div>
        )}
        {githubError && <p className="setup-note muted">{githubError}</p>}
        <div className="setup-or">or with email</div>
        <form className="setup-email" onSubmit={sendMagicLink}>
          <input
            className="field"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button className="btn" type="submit" disabled={sending || emailWaiting || !email.trim()}>
            {emailWaiting ? "Waiting for link…" : "Continue with email"}
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
        {emailWaiting && (
          <p className="setup-note muted">
            Keep this window open — signing you in automatically once you tap the link.{" "}
            <button type="button" className="btn link" onClick={cancelEmailSignIn}>
              Cancel
            </button>
          </p>
        )}
        {sentTo && !sending && (
          <p className="setup-note muted">
            Didn't get it? Check your spam folder, or{" "}
            <button type="button" className="btn link" onClick={() => void requestMagicLink(sentTo)}>
              resend the link
            </button>
            . You can also edit the address above and send again.
          </p>
        )}
        <p className="setup-foot muted">
          By continuing, you agree to the <a href="https://bivy.sh/terms.html">Terms</a> and acknowledge the{" "}
          <a href="https://bivy.sh/privacy.html">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}
