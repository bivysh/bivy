// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../clipboard.js";
import { installCommand } from "../installCommand.js";
import { controller } from "../store/useStore.js";
import { CheckIcon, CopyIcon } from "./UiIcons.js";

/** Shared install instructions used wherever someone connects another Machine. */
export function MachineInstallInstructions() {
  const [copied, setCopied] = useState<"auto" | "plain" | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const install = installCommand(location.origin, controller.local.relay, controller.local.s);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const copyCommand = async (command: string, kind: "auto" | "plain") => {
    const ok = await writeClipboard(command);
    if (!ok) return;
    setCopied(kind);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="settings-form machine-install-instructions">
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
                onClick={() => copyCommand(install.command, "auto")}
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
              onClick={() => copyCommand(install.plainCommand, "plain")}
              aria-label={copied === "plain" ? "Regular sign-in command copied" : "Copy regular sign-in command"}
              title={copied === "plain" ? "Copied" : "Copy regular sign-in command"}
            >
              {copied === "plain" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
            </button>
          </div>
        </div>
      </div>
      <p className="muted">The new Machine shows up in the Machine switcher as soon as it connects.</p>
    </div>
  );
}
