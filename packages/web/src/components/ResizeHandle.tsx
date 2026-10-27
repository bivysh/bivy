// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { clampWidth, type PanelSize } from "../usePanelWidth.js";

const KEY_STEP = 16;

/**
 * A vertical drag edge that resizes the panel it sits in. `edge` says which
 * side of the panel it is on, so dragging toward the panel's outside grows it.
 * Arrow keys resize too, and a double-click (or Home) restores the default.
 * `width` is null until the user resizes. Resizing always starts from the
 * panel's rendered width, which the stylesheet may cap below `width`.
 */
export function ResizeHandle({ label, edge, size, width, onResize }: {
  label: string;
  edge: "end" | "start";
  size: PanelSize;
  width: number | null;
  onResize: (width: number | null) => void;
}) {
  const drag = useRef<{ x: number; start: number } | null>(null);
  const sign = edge === "end" ? 1 : -1;
  const current = (el: HTMLElement) => el.parentElement?.getBoundingClientRect().width ?? width ?? size.min;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: current(event.currentTarget) };
    document.documentElement.classList.add("is-resizing");
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(drag.current.start + sign * (event.clientX - drag.current.x));
  };
  const endDrag = () => {
    drag.current = null;
    document.documentElement.classList.remove("is-resizing");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? KEY_STEP : event.key === "ArrowLeft" ? -KEY_STEP : 0;
    if (event.key === "Home") { event.preventDefault(); onResize(null); return; }
    if (!step) return;
    event.preventDefault();
    onResize(current(event.currentTarget) + sign * step);
  };

  return (
    <div
      className={`resize-handle ${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      aria-valuenow={width === null ? undefined : clampWidth(size, width)}
      tabIndex={0}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onResize(null)}
      onKeyDown={onKeyDown}
    />
  );
}
