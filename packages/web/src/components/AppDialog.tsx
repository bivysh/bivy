// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

const FOCUSABLE = 'a[href],button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])';
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
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = bodyRef.current ? Array.from(bodyRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);
  // Unique id per instance — a hardcoded id collides if two dialogs ever mount.
  const titleId = useId();
  // Dialogs can be opened from the transformed mobile sidebar. Portal them so
  // position:fixed remains relative to the viewport rather than the drawer.
  return createPortal(
    <div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="app-dialog-backdrop" onClick={onCancel} />
      <div className="app-dialog-body" ref={bodyRef}>
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
  const bodyRef = useRef<HTMLFormElement>(null);
  useModalEscape(onCancel);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = bodyRef.current ? Array.from(bodyRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
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
      <form ref={bodyRef} className="app-dialog-body" onSubmit={submit}>
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
