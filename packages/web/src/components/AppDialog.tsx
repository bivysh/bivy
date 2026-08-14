// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useModalEscape } from "../modalStack.js";

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Escape cancels — but only when this dialog is the topmost layer, so an
  // Escape here never also closes the Settings modal or sheet underneath it.
  useModalEscape(onCancel);
  // Move focus into the dialog on open so a keyboard user isn't stranded behind
  // it, and land on Cancel (never the destructive confirm) so a reflexive
  // Enter/Space can't fire an irreversible action.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  // Unique id per instance — a hardcoded id collides if two dialogs ever mount.
  const titleId = useId();
  // Dialogs can be opened from the transformed mobile sidebar. Portal them so
  // position:fixed remains relative to the viewport rather than the drawer.
  return createPortal(
    <div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="app-dialog-backdrop" onClick={onCancel} />
      <div className="app-dialog-body">
        <h3 id={titleId}>{title}</h3>
        <p>{message}</p>
        <div className="app-dialog-actions">
          <button ref={cancelRef} className="btn" onClick={onCancel}>Cancel</button>
          <button className={danger ? "btn danger" : "btn primary"} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function RenameDialog({
  title = "Rename",
  initialValue,
  onSave,
  onCancel,
}: {
  title?: string;
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useModalEscape(onCancel);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const titleId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = value.trim();
    if (next && next !== initialValue) onSave(next);
    else onCancel();
  };
  return createPortal(
    <div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="app-dialog-backdrop" onClick={onCancel} />
      <form className="app-dialog-body" onSubmit={submit}>
        <h3 id={titleId}>{title}</h3>
        <input ref={inputRef} className="picker-search" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="app-dialog-actions">
          <button className="btn" type="button" onClick={onCancel}>Cancel</button>
          <button className="btn primary" type="submit" disabled={!value.trim()}>Save</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
