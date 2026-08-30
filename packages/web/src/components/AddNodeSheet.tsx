// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import { Sheet } from "./Sheet.js";
import { writeClipboard } from "../clipboard.js";
import { installCommand } from "../installCommand.js";
import { controller } from "../store/useStore.js";
import { CheckIcon, CopyIcon } from "./UiIcons.js";

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
          {!install.hosted && " Needs Node.js 20 or newer; setup will point the Machine at this control plane."}
        </p>
        <div className="install-command-list">
          {install.authenticated && (
            <div className="install-command-option">
              <div className="install-command-label">Auto sign-in</div>
              <div className="connect-command">
                <code>{install.command}</code>
                <button
                  type="button"
                  className={`btn sm ghost icon-only${copied === "auto" ? " is-copied" : ""}`}
                  onClick={async () => {
                    const ok = await writeClipboard(install.command);
                    if (ok) {
                      setCopied("auto");
                      setTimeout(() => setCopied(null), 1500);
                    }
                  }}
                  aria-label={copied === "auto" ? "Auto sign-in command copied" : "Copy auto sign-in command"}
                  title={copied === "auto" ? "Copied" : "Copy auto sign-in command"}
                >
                  {copied === "auto" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                </button>
              </div>
              <p className="muted">Includes an account token. Paste it only into a Machine you trust.</p>
            </div>
          )}
          <div className="install-command-option">
            <div className="install-command-label">Regular sign-in</div>
            <div className="connect-command">
              <code>{install.plainCommand}</code>
              <button
                type="button"
                className={`btn sm ghost icon-only${copied === "plain" ? " is-copied" : ""}`}
                onClick={async () => {
                  const ok = await writeClipboard(install.plainCommand);
                  if (ok) {
                    setCopied("plain");
                    setTimeout(() => setCopied(null), 1500);
                  }
                }}
                aria-label={copied === "plain" ? "Regular sign-in command copied" : "Copy regular sign-in command"}
                title={copied === "plain" ? "Copied" : "Copy regular sign-in command"}
              >
                {copied === "plain" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
              </button>
            </div>
          </div>
        </div>
        <p className="muted">The new Machine shows up in this switcher as soon as it connects — no need to close this.</p>
      </div>
    </Sheet>
  );
}
