// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import { Sheet } from "./Sheet.js";
import { writeClipboard } from "../clipboard.js";

const INSTALL_CMD = "curl -fsSL https://bivy.sh/install.sh | bash";

/**
 * Reached from the node switcher's "Add a node…" entry. Spells out how to
 * connect another machine as a node — the switcher only ever lists nodes you
 * already have, so anyone with just one (or zero) had no in-app hint that
 * more can be added, short of remembering the install command from setup.
 */
export function AddNodeSheet({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <Sheet title="Add a machine" onClose={onClose}>
      <div className="settings-form">
        <p className="muted">
          Run this on any Mac or Linux computer to install Bivy there and connect it as a new machine on your account.
        </p>
        <pre className="code-snippet">
          <code>{INSTALL_CMD}</code>
        </pre>
        <div className="row-actions">
          <button
            className="btn primary"
            onClick={async () => {
              const ok = await writeClipboard(INSTALL_CMD);
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            {copied ? "Copied!" : "Copy command"}
          </button>
          <a className="btn ghost" href="/install.sh">Download script</a>
        </div>
        <p className="muted">The new machine shows up in this switcher as soon as it connects — no need to close this.</p>
      </div>
    </Sheet>
  );
}
