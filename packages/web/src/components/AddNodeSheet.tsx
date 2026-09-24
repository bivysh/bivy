// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";
import { PersistentServerPanel } from "./PersistentServer.js";
import { MachineInstallInstructions } from "./MachineInstallInstructions.js";
import { Sheet } from "./Sheet.js";

/**
 * Reached from the node switcher's "Add a node…" entry. Spells out how to
 * connect another machine as a node — the switcher only ever lists nodes you
 * already have, so anyone with just one (or zero) had no in-app hint that
 * more can be added, short of remembering the install command from setup.
 */
export function AddNodeSheet({ onClose, initialMode = "existing" }: { onClose: () => void; initialMode?: "existing" | "server" }) {
  const [mode, setMode] = useState(initialMode);
  const server = EPHEMERAL_MACHINES_ENABLED && mode === "server";
  return (
    <Sheet title={server ? "Create your own Hetzner server" : "Add a Machine"} onClose={onClose} variant="centered">
      {server ? <PersistentServerPanel providerId="hetzner" onDone={onClose} /> : <>
        <MachineInstallInstructions />
        {EPHEMERAL_MACHINES_ENABLED && <div className="settings-section">
          <h3>Need a server?</h3>
          <p className="muted">Create an always-on server in your own Hetzner account. Keep your tools and files between sessions; pay Hetzner directly.</p>
          <button className="btn" onClick={() => setMode("server")}>Create your own server</button>
        </div>}
      </>}
    </Sheet>
  );
}
