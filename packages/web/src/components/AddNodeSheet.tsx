// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { MachineInstallInstructions } from "./MachineInstallInstructions.js";
import { Sheet } from "./Sheet.js";
import { controller, useAppState } from "../store/useStore.js";

/**
 * Reached from the node switcher's "Add a node…" entry. Spells out how to
 * connect another machine as a node — the switcher only ever lists nodes you
 * already have, so anyone with just one (or zero) had no in-app hint that
 * more can be added, short of remembering the install command from setup.
 *
 * Once the command is used, it watches for that machine to come online, then
 * switches to it and closes, so the list never needs a reload to show it.
 */
export function AddNodeSheet({ onClose }: { onClose: () => void }) {
  const [enrolledNodeId, setEnrolledNodeId] = useState<string | null>(null);
  const online = useAppState().connection.nodes.some((node) => node.id === enrolledNodeId && node.online);
  useEffect(() => {
    if (!enrolledNodeId) return;
    if (online) {
      controller.switchNode(enrolledNodeId);
      onClose();
      return;
    }
    const timer = setInterval(() => void controller.refreshNodes(), 3000);
    return () => clearInterval(timer);
  }, [enrolledNodeId, online, onClose]);
  return (
    <Sheet title="Add a Machine" onClose={onClose} variant="centered">
      <MachineInstallInstructions onEnrolled={setEnrolledNodeId} />
    </Sheet>
  );
}
