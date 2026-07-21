// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState, type FormEvent } from "react";

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
      <div className="app-dialog-backdrop" onClick={onCancel} />
      <div className="app-dialog-body">
        <h3 id="app-dialog-title">{title}</h3>
        <p>{message}</p>
        <div className="app-dialog-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className={danger ? "btn danger" : "btn primary"} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
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
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = value.trim();
    if (next && next !== initialValue) onSave(next);
    else onCancel();
  };
  return (
    <div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
      <div className="app-dialog-backdrop" onClick={onCancel} />
      <form className="app-dialog-body" onSubmit={submit}>
        <h3 id="app-dialog-title">{title}</h3>
        <input ref={inputRef} className="picker-search" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="app-dialog-actions">
          <button className="btn" type="button" onClick={onCancel}>Cancel</button>
          <button className="btn primary" type="submit" disabled={!value.trim()}>Save</button>
        </div>
      </form>
    </div>
  );
}
