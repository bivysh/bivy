// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import { Sheet } from "./Sheet.js";
import { writeClipboard } from "../clipboard.js";
import { installCommand } from "../installCommand.js";
import { controller } from "../store/useStore.js";

/**
 * Reached from the node switcher's "Add a node…" entry. Spells out how to
 * connect another machine as a node — the switcher only ever lists nodes you
 * already have, so anyone with just one (or zero) had no in-app hint that
 * more can be added, short of remembering the install command from setup.
 */
export function AddNodeSheet({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState<"auto" | "plain" | null>(null);
  // Same command the first-run screen shows — hosted installer, or a
  // self-hosted `bivy setup` pointed at this control plane (installCommand.ts).
  const install = installCommand(location.origin, controller.local.relay, controller.local.s);

  return (
    <Sheet title="Add a Machine" onClose={onClose}>
      <div className="settings-form">
        <p className="muted">
          Run this on any Mac or Linux computer to install Bivy there and connect it as a new Machine on your account.
          {install.authenticated && " It will use this signed-in account automatically."}
          {!install.hosted && " Needs Node.js 22.19 or newer; setup will point the Machine at this control plane."}
        </p>
        <pre className="code-snippet">
          <code>{install.command}</code>
        </pre>
        {install.authenticated && (
          <p className="muted">Auto sign-in includes an account token. Paste it only into a Machine you trust, or copy the plain command below.</p>
        )}
        <div className="row-actions">
          <button
            className="btn primary"
            onClick={async () => {
              const ok = await writeClipboard(install.command);
              if (ok) {
                setCopied("auto");
                setTimeout(() => setCopied(null), 1500);
              }
            }}
          >
            {copied === "auto" ? "Copied!" : install.authenticated ? "Copy auto sign-in" : "Copy command"}
          </button>
          {install.authenticated && (
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
          {install.hosted && <a className="btn ghost" href="/install.sh">Download script</a>}
        </div>
        <p className="muted">The new Machine shows up in this switcher as soon as it connects — no need to close this.</p>
      </div>
    </Sheet>
  );
}
