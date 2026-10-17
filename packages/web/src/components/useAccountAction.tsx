// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Runs a deployment extension's account action the same way everywhere it is
// offered: ask its confirm question first (if any), then either open the page
// the extension hands back or, when it completed in place, hand its message to
// the caller, which shows it where it reads best and reloads what changed.
import { useState, type ReactNode } from "react";
import { controller } from "../store/useStore.js";
import { ConfirmDialog } from "./AppDialog.js";
import { openAccountAction } from "../packaged-client.js";
import { accountAction, type AccountAction } from "../accountHeader.js";

export function useAccountAction({ onDone, onError }: {
  /** The action completed in place: show `message` and reload the account view. */
  onDone: (message: string) => void;
  onError: (message: string) => void;
}): { busy: string | null; run: (action: { id: string; label: string; confirm?: unknown }) => void; dialog: ReactNode } {
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<AccountAction | null>(null);

  const invoke = (action: AccountAction) => {
    setBusy(action.id);
    controller.invokeAccountExtensionAction(action.id)
      .then(async (result) => {
        if ("url" in result) return openAccountAction(result.url);
        onDone(result.message || "Done.");
      })
      .catch((e) => onError(String(e?.message || e)))
      .finally(() => setBusy(null));
  };

  const run = (raw: { id: string; label: string; confirm?: unknown }) => {
    const action = accountAction(raw);
    if (action.confirm) setPending(action);
    else invoke(action);
  };

  const dialog = pending && (
    <ConfirmDialog
      title={pending.label}
      message={pending.confirm!}
      confirmLabel={pending.label || "Continue"}
      onCancel={() => setPending(null)}
      onConfirm={() => { setPending(null); invoke(pending); }}
    />
  );

  return { busy, run, dialog };
}
