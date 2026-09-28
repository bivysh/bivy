// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { useModalEscape } from "../modalStack.js";
import { CheckIcon, MoreIcon } from "./UiIcons.js";

export type MoreItem = { heading: string } | { label: string; danger?: boolean; disabled?: boolean; onSelect: () => void;
  /** A choice among the items after the last heading (menuitemradio), or with `toggle` an on/off switch (menuitemcheckbox). */
  checked?: boolean;
  toggle?: boolean;
  /** A rule above it, to set it apart from the choices before. */
  separated?: boolean };
/** Rare or destructive actions, and settings, behind a ⋯ button (the canonical .menu). */
export function MoreMenu({ label, items, onOpen }: { label: string; items: MoreItem[]; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    ref.current?.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")?.focus();
  };
  useModalEscape(close, open);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>("[role^=menuitem]:not(:disabled)")?.focus();
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  return <div className="apps-more" ref={ref}>
    <button type="button" className="btn ghost icon" aria-label={label} title="More" aria-haspopup="menu" aria-expanded={open}
      onClick={(e) => { e.stopPropagation(); if (!open) onOpen?.(); setOpen((v) => !v); }}><MoreIcon size={18} /></button>
    {open && <div className="menu apps-more-menu" role="menu" aria-label={label}>
      {items.map((item) => "heading" in item
        ? <div key={item.heading} className="menu-heading" role="presentation">{item.heading}</div>
        : <button key={item.label} type="button" role={item.checked === undefined ? "menuitem" : item.toggle ? "menuitemcheckbox" : "menuitemradio"} aria-checked={item.checked}
            className={`menu-item${item.danger ? " danger" : ""}${item.separated ? " separated" : ""}`} disabled={item.disabled}
            onClick={() => { close(); item.onSelect(); }}>
            <span className="menu-item-label">{item.label}</span>{item.checked && <CheckIcon size={15} aria-hidden />}
          </button>)}
    </div>}
  </div>;
}
