// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { MachineInstallInstructions } from "./MachineInstallInstructions.js";
import { Sheet } from "./Sheet.js";

/**
 * Reached from the node switcher's "Add a node…" entry. Spells out how to
 * connect another machine as a node — the switcher only ever lists nodes you
 * already have, so anyone with just one (or zero) had no in-app hint that
 * more can be added, short of remembering the install command from setup.
 */
export function AddNodeSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Add a Machine" onClose={onClose} variant="centered">
      <MachineInstallInstructions />
    </Sheet>
  );
}
