// SPDX-License-Identifier: AGPL-3.0-only
import { accountOrigin } from "../packaged-client.js";
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import type { AccountNodeClaim } from "@bivy/core";
import { writeClipboard } from "../clipboard.js";
import { installCommand } from "../installCommand.js";
import { controller } from "../store/useStore.js";
import { CheckIcon, CopyIcon } from "./UiIcons.js";

/** One enrollment-only command, shared by first-run setup and Add Machine. */
export function MachineInstallInstructions({ onEnrolled }: { onEnrolled?: (nodeId: string) => void }) {
  const [claim, setClaim] = useState<AccountNodeClaim | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"claim" | "plain" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<Promise<AccountNodeClaim> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enrolled = useRef(onEnrolled);
  enrolled.current = onEnrolled;
  // Never place the reusable browser session in a shell command. Older servers
  // can still use the explicit, ordinary sign-in fallback below.
  const install = installCommand(accountOrigin(), controller.local.relay);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    request.current ??= controller.createNodeClaim();
    void request.current.then((value) => {
      if (!value.command) throw new Error("This server did not return an install command.");
      if (!cancelled) setClaim(value);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [attempt]);

  useEffect(() => {
    if (!claim || claim.status !== "pending") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (Date.parse(claim.expiresAt) <= Date.now()) {
          if (!cancelled) setClaim({ ...claim, status: "expired", command: undefined });
          return;
        }
        const claims = await controller.listNodeClaims();
        if (cancelled) return;
        const updated = claims.find((item) => item.id === claim.id);
        setError(null);
        if (updated && updated.status !== "pending") {
          setClaim({ ...updated, command: undefined });
          if (updated.status === "used" && updated.nodeId) enrolled.current?.(updated.nodeId);
          return;
        }
      } catch {
        if (!cancelled) setError("Could not check installation progress. Retrying automatically…");
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [claim]);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const copyCommand = async (command: string, kind: "claim" | "plain") => {
    if (!await writeClipboard(command)) {
      setError("Could not copy. Select and copy the command manually.");
      return;
    }
    setCopied(kind);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  };
  const renew = () => {
    request.current = null;
    setClaim(null);
    setCopied(null);
    setAttempt((value) => value + 1);
  };

  return (
    <div className="settings-form machine-install-instructions">
      <h3>Run this on your machine</h3>
      <p className="muted">On your Mac or Linux computer, open a terminal in your repository and paste this command. It installs Bivy and connects your machine to this account.</p>
      {busy && <p className="muted" role="status">Preparing your one-time install command…</p>}
      {error && <p className="banner inline" data-tone="danger" role="alert">{error}</p>}
      {claim?.status === "pending" && claim.command && (
        <>
          <div className="connect-command">
            <code tabIndex={0} aria-label="One-time install command">{claim.command}</code>
            <button type="button" className={`btn sm ghost icon-only${copied === "claim" ? " is-copied" : ""}`} onClick={() => void copyCommand(claim.command!, "claim")} aria-label={copied === "claim" ? "Install command copied" : "Copy install command"} title={copied === "claim" ? "Copied" : "Copy install command"}>
              {copied === "claim" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
            </button>
          </div>
          <p className="muted">Single-use · expires in 10 minutes. Paste only on a machine you trust. No second Bivy sign-in required.</p>
        </>
      )}
      {claim?.status === "used" && <div role="status"><p>Machine enrolled. Waiting for it to come online…</p><p className="muted">Keep the installer running until it finishes. If it reports a service error, follow its recovery instructions on the machine.</p></div>}
      {(claim?.status === "expired" || claim?.status === "revoked") && <p role="status">This install command has {claim.status === "expired" ? "expired" : "been revoked"}. Create a new one to continue.</p>}
      {!busy && claim?.status !== "pending" && claim?.status !== "used" && <button type="button" className="btn primary" onClick={renew}>{claim ? "Create new install command" : "Retry install command"}</button>}
      <p className="muted">Bivy runs in the background and detects available agents. Existing agent logins are reused where supported. Keep this machine awake and online while work runs.</p>
      <details>
        <summary>Other ways to install</summary>
        <p className="muted">Use this command if you prefer to sign in on the machine.{!install.hosted && " It connects to your self-hosted server."}</p>
        <div className="connect-command">
          <code tabIndex={0}>{install.plainCommand}</code>
          <button type="button" className={`btn sm ghost icon-only${copied === "plain" ? " is-copied" : ""}`} onClick={() => void copyCommand(install.plainCommand, "plain")} aria-label={copied === "plain" ? "Regular sign-in command copied" : "Copy regular sign-in command"}>{copied === "plain" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}</button>
        </div>
      </details>
    </div>
  );
}
