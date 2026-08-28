// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalEscape } from "../modalStack.js";
import { CheckIcon, CloseIcon } from "./UiIcons.js";

const FOCUSABLE = 'a[href],button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** A bottom sheet / modal shell shared by the composer pickers and settings. */
export function Sheet({
  title,
  onClose,
  children,
  headExtra,
  autoFocusSearch = true,
  variant = "default",
  ariaLabel,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  headExtra?: ReactNode;
  variant?: "default" | "action";
  ariaLabel?: string;
  /** Focus the search input on open. Off for list-heavy pickers on mobile,
   *  where popping the keyboard collapses the list to a couple of rows — we'd
   *  rather show the list and let the user tap the field to search. */
  autoFocusSearch?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStartY = useRef<number | null>(null);
  const dragYRef = useRef(0);
  const [isClosing, setIsClosing] = useState(false);
  const [dragY, setDragY] = useState(0);

  // Let the sheet finish its dismissal motion before the parent unmounts it.
  // This makes taps, backdrop clicks, Escape, and swipe dismissal feel like the
  // same native interaction instead of disappearing synchronously.
  const requestClose = () => {
    if (isClosing) return;
    setIsClosing(true);
    dragYRef.current = 0;
    setDragY(0);
    closeTimer.current = setTimeout(onClose, 200);
  };

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isClosing) return;
    dragStartY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHandlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStartY.current == null || isClosing) return;
    const nextY = Math.max(0, Math.min(event.clientY - dragStartY.current, 320));
    dragYRef.current = nextY;
    setDragY(nextY);
  };
  const onHandlePointerUp = () => {
    if (dragStartY.current == null) return;
    const shouldClose = dragYRef.current > 96;
    dragStartY.current = null;
    dragYRef.current = 0;
    if (shouldClose) requestClose();
    else setDragY(0);
  };

  // Escape closes — coordinated so only the topmost open layer responds (a
  // popover or dialog raised from inside the sheet cancels itself first, rather
  // than this sheet closing out from under it).
  useModalEscape(requestClose);

  // Modal focus management: move focus into the sheet on open, keep Tab inside
  // it, and restore focus to the opener on close so keyboard / screen-reader
  // users aren't left behind the backdrop.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const body = bodyRef.current;
    const focusables = () => (body ? Array.from(body.querySelectorAll<HTMLElement>(FOCUSABLE)) : []);
    // Prefer the search input if the sheet has one, else the first control. When
    // auto-focus is off, focus the dialog container itself (tabindex=-1) instead:
    // focus stays trapped in the sheet (Tab/restore-on-close still work) but no
    // soft keyboard opens, so the full list is visible.
    const first = autoFocusSearch
      ? (body?.querySelector<HTMLElement>('input, textarea') ?? focusables()[0])
      : body;
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault();
        firstEl.focus();
      } else if (body && activeEl instanceof Node && !body.contains(activeEl)) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [autoFocusSearch]);

  // Portal to <body>. The sheet is `position: fixed`, but it's rendered from
  // deep inside the `.chat` scroll container (overflow-y:auto +
  // -webkit-overflow-scrolling:touch). On iOS a fixed element does NOT escape a
  // scrolling ancestor — it anchors to the scrolled content instead of the
  // viewport. That made the sheet run under the composer (so it looked capped),
  // broke its inner scroll, and made it scroll out of view (look "closed")
  // whenever new content pinned the chat to the bottom. At <body> it is truly
  // viewport-fixed and independent of the transcript's scroll and windowing.
  return createPortal(
    <div className={`sheet${isClosing ? " is-closing" : ""}`} data-variant={variant} role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <div
        className="sheet-backdrop"
        onClick={requestClose}
        style={dragY > 0 ? { opacity: Math.max(0.25, 1 - dragY / 320) } : undefined}
      />
      <div
        className={`sheet-body${isClosing ? " is-closing" : ""}`}
        ref={bodyRef}
        tabIndex={-1}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
      >
        <div
          className="sheet-grabber"
          aria-hidden="true"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
        />
        <div
          className="sheet-head"
          onPointerDown={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest("button, a, input, textarea, select")) return;
            onHandlePointerDown(event);
          }}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
        >
          <span className="sheet-title">{title}</span>
          {headExtra}
          <button className="sheet-close" onClick={requestClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-content">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A selectable row in a picker list. */
export function PickerItem({
  active,
  title,
  meta,
  right,
  onClick,
  disabled,
}: {
  active?: boolean;
  title: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  // `right` (a status chip, or an action like Revoke/Remove) used to render
  // *inside* the row's <button>. That's fine for inert content (a <span> chip)
  // but breaks the instant `right` is itself a real, focusable <button> — a
  // <button> nested inside a <button> is invalid HTML, and browsers hoist/
  // mis-parse it, so the inner action becomes unreachable by keyboard and
  // unreliable to tap. Render the select button and `right` as siblings
  // instead (same shape as SessionList's `.session-row` + row-menu button).
  return (
    <div className={`picker-item-row${active ? " active" : ""}`}>
      <button className="picker-item" onClick={onClick} disabled={disabled}>
        <span className="picker-check">{active ? <CheckIcon size={15} /> : null}</span>
        <span className="picker-main">
          <span className="picker-name">{title}</span>
          {meta != null && <span className="picker-meta">{meta}</span>}
        </span>
      </button>
      {right != null && <span className="picker-item-extra">{right}</span>}
    </div>
  );
}
