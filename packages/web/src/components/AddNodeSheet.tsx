// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useState } from "react";
import { Sheet } from "./Sheet.js";
import { writeClipboard } from "../clipboard.js";
import { installCommand } from "../installCommand.js";
import { controller } from "../store/useStore.js";

/**
 * Reached from the node switcher's "Add a machine…" entry. Hosted accounts get
 * a fresh, short-lived enrollment claim as soon as the sheet opens. The claim
 * can enroll exactly one machine and cannot access the account on its own.
 * Self-hosted/direct deployments keep the generic setup command because they
 * do not have an authenticated hosted account against which to mint a claim.
 */
export function AddNodeSheet({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState<"auto" | "plain" | null>(null);
  const [claim, setClaim] = useState<Awaited<ReturnType<typeof controller.createNodeClaim>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Same command the first-run screen shows — hosted installer, or a
  // self-hosted `bivy setup` pointed at this control plane (installCommand.ts).
  const install = installCommand(location.origin, controller.local.relay, controller.local.s);

  const createClaim = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setClaim(await controller.createNodeClaim());
    } catch (cause) {
      setError(String((cause as Error)?.message || cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (install.hosted) void createClaim();
  }, [createClaim, install.hosted]);

  const command = install.hosted ? claim?.command : install.command;

  return (
    <Sheet title="Add a Machine" onClose={onClose}>
      <div className="settings-form">
        <p className="muted">
          {install.hosted
            ? "Run this on any Mac or Linux computer. Bivy is installed, signed in to this account, and enrolled as a new Machine automatically."
            : "Run this on any Mac or Linux computer. Needs Node.js 22.19 or newer; setup will point the Machine at this control plane."}
        </p>
        {install.hosted && <p className="muted small">This one-time command expires after 10 minutes and can enroll only one Machine.</p>}
        {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
        {command ? (
          <pre className="code-snippet">
            <code>{command}</code>
          </pre>
        ) : (
          <p className="muted" role="status">{busy ? "Creating your secure install command…" : "Install command unavailable."}</p>
        )}
        <div className="row-actions">
          <button
            className="btn primary"
            disabled={!command}
            onClick={async () => {
              if (!command) return;
              const ok = await writeClipboard(command);
              if (ok) {
                setCopied("auto");
                setTimeout(() => setCopied(null), 1500);
              }
            }}
          >
            {copied === "auto" ? "Copied!" : install.hosted || install.authenticated ? "Copy auto sign-in" : "Copy command"}
          </button>
          {install.authenticated && !install.hosted && (
            <button
              className="btn ghost"
              onClick={async () => {
                const ok = await writeClipboard(install.plainCommand);
                if (ok) {
                  setCopied("plain");
                  setTimeout(() => setCopied(null), 1500);
                }
              }}
            >
              {copied === "plain" ? "Copied plain!" : "Copy plain"}
            </button>
          )}
          {install.hosted && !command && !busy && <button className="btn" onClick={() => void createClaim()}>Try again</button>}
          {install.hosted && <a className="btn ghost" href="/install.sh">Download script</a>}
        </div>
        <p className="muted">The new Machine shows up in this switcher as soon as it connects — no additional setup or sign-in required.</p>
      </div>
    </Sheet>
  );
}
