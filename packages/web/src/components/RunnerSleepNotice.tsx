// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { controller } from "../store/useStore.js";
import { runnerDeletionNotice } from "../cloudDestinations.js";

/**
 * Shown above the composer for a session on a sleeping Cloud Runner: the
 * deployment deletes a runner (and the session on it) after it has slept long
 * enough, so say when, and that sending a message keeps it.
 */
export function RunnerSleepNotice({ nodeId }: { nodeId: string }) {
  const [deleteAt, setDeleteAt] = useState<string>();
  useEffect(() => {
    let live = true;
    setDeleteAt(undefined);
    controller.listHostedMachines()
      .then((machines) => { if (live) setDeleteAt(machines.find((machine) => machine.nodeId === nodeId)?.deleteAt); })
      .catch(() => {});
    return () => { live = false; };
  }, [nodeId]);
  const notice = runnerDeletionNotice(deleteAt);
  if (!notice) return null;
  return (
    <div className="banner handoff-banner" data-tone={notice.soon ? "warn" : "neutral"} role="status">
      <span className="banner-text">
        <strong>This Cloud Runner is asleep.</strong>
        <span>It will be deleted with this session on {notice.day}. Send a message to wake it and keep it.</span>
      </span>
    </div>
  );
}
