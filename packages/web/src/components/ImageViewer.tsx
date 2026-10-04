// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalEscape } from "../modalStack.js";
import { Spinner } from "./Spinner.js";

type Point = { x: number; y: number };
const FIT = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 8;

/** A self-contained image surface: gestures never zoom or scroll the page. */
export function ImageViewer({ src, name, current = 0, count = 1, onNavigate, onClose }: {
  src: string | null; name: string; current?: number; count?: number;
  onNavigate?: (delta: number) => void; onClose: () => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [view, setView] = useState(FIT);
  const state = useRef(FIT);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const swipe = useRef<Point | null>(null);
  useModalEscape(onClose);

  const apply = useCallback((next: typeof FIT) => {
    const area = viewport.current;
    const img = image.current;
    if (!area || !img) return;
    const scale = Math.max(1, Math.min(MAX_ZOOM, next.scale));
    const maxX = Math.max(0, (img.clientWidth * scale - area.clientWidth) / 2);
    const maxY = Math.max(0, (img.clientHeight * scale - area.clientHeight) / 2);
    state.current = { scale, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
    setView(state.current);
  }, []);

  const zoom = useCallback((scale: number, anchor: Point = { x: 0, y: 0 }) => {
    const old = state.current;
    const ratio = Math.max(1, Math.min(MAX_ZOOM, scale)) / old.scale;
    apply({ scale: old.scale * ratio, x: anchor.x - (anchor.x - old.x) * ratio, y: anchor.y - (anchor.y - old.y) * ratio });
  }, [apply]);

  useEffect(() => {
    const node = overlay.current!;
    const previous = document.activeElement as HTMLElement | null;
    node.focus();
    // React's delegated wheel/touch listeners are passive. Native listeners
    // are required to contain trackpad pinches and iOS rubber-band scrolling.
    const stop = (event: Event) => event.stopPropagation();
    const prevent = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
    const wheel = (event: WheelEvent) => {
      prevent(event);
      const rect = viewport.current!.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoom(state.current.scale * Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.x - rect.width / 2, y: event.clientY - rect.y - rect.height / 2 });
      } else {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
        apply({ ...state.current, x: state.current.x - event.deltaX * unit, y: state.current.y - event.deltaY * unit });
      }
    };
    node.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("touchmove", prevent, { passive: false });
    for (const type of ["touchstart", "touchend", "touchcancel"]) node.addEventListener(type, stop);
    node.addEventListener("gesturestart", prevent);
    node.addEventListener("gesturechange", prevent);
    const resize = new ResizeObserver(() => apply(state.current));
    resize.observe(viewport.current!);
    return () => {
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("touchmove", prevent);
      for (const type of ["touchstart", "touchend", "touchcancel"]) node.removeEventListener(type, stop);
      node.removeEventListener("gesturestart", prevent);
      node.removeEventListener("gesturechange", prevent);
      resize.disconnect();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [apply, zoom]);

  return createPortal(
    <div ref={overlay} className="image-viewer" role="dialog" aria-modal="true" aria-label={`${name} — Image ${current + 1} of ${count}`} tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Tab") {
          const buttons = [...overlay.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          e.preventDefault();
          const next = index < 0 ? (e.shiftKey ? buttons.length - 1 : 0) : (index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
          return;
        }
        if (["+", "=", "-", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
          e.preventDefault(); e.stopPropagation();
          if (e.key === "+" || e.key === "=") zoom(state.current.scale * 1.5);
          else if (e.key === "-") zoom(state.current.scale / 1.5);
          else if (e.key === "0") apply(FIT);
          else if (state.current.scale > 1) apply({ ...state.current, x: state.current.x + (e.key === "ArrowLeft" ? 80 : e.key === "ArrowRight" ? -80 : 0), y: state.current.y + (e.key === "ArrowUp" ? 80 : e.key === "ArrowDown" ? -80 : 0) });
          else if (e.key === "ArrowLeft" || e.key === "ArrowRight") onNavigate?.(e.key === "ArrowLeft" ? -1 : 1);
        }
      }}>
      <div ref={viewport} className="image-viewer-viewport" data-zoomed={view.scale > 1}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          zoom(state.current.scale > 1 ? 1 : 2, { x: e.clientX - rect.x - rect.width / 2, y: e.clientY - rect.y - rect.height / 2 });
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const point = { x: e.clientX, y: e.clientY };
          pointers.current.set(e.pointerId, point);
          swipe.current = pointers.current.size === 1 && state.current.scale === 1 ? point : null;
        }}
        onPointerMove={(e) => {
          const old = pointers.current.get(e.pointerId);
          if (!old) return;
          const next = { x: e.clientX, y: e.clientY };
          const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
          if (other) {
            const distance = Math.hypot(old.x - other.x, old.y - other.y);
            const rect = e.currentTarget.getBoundingClientRect();
            const anchor = { x: (old.x + other.x) / 2 - rect.x - rect.width / 2, y: (old.y + other.y) / 2 - rect.y - rect.height / 2 };
            if (distance > 0) zoom(state.current.scale * Math.hypot(next.x - other.x, next.y - other.y) / distance, anchor);
            apply({ ...state.current, x: state.current.x + (next.x - old.x) / 2, y: state.current.y + (next.y - old.y) / 2 });
          } else if (state.current.scale > 1) {
            apply({ ...state.current, x: state.current.x + next.x - old.x, y: state.current.y + next.y - old.y });
          }
          pointers.current.set(e.pointerId, next);
        }}
        onPointerUp={(e) => {
          const start = swipe.current;
          pointers.current.delete(e.pointerId);
          swipe.current = null;
          if (!start || state.current.scale !== 1) return;
          const dx = e.clientX - start.x, dy = e.clientY - start.y;
          if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy)) onNavigate?.(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={() => { pointers.current.clear(); swipe.current = null; }}
        onLostPointerCapture={(e) => { pointers.current.delete(e.pointerId); swipe.current = null; }}>
        {src && !failed && <img ref={image} className="image-viewer-img" src={src} alt={name} draggable={false}
          onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />}
        {failed ? <p className="image-viewer-message" role="alert">Unable to load image.</p> : !loaded && <span role="status" aria-label="Loading image"><Spinner size="lg" tone="inverse" /></span>}
      </div>
      <div className="image-viewer-tools" role="group" aria-label="Image zoom">
        <button type="button" className="btn icon" aria-label="Zoom out" disabled={!loaded || view.scale <= 1} onClick={() => zoom(view.scale / 1.5)}>−</button>
        <button type="button" className="btn" aria-label="Fit image" disabled={!loaded} onClick={() => apply(FIT)}>{Math.round(view.scale * 100)}%</button>
        <button type="button" className="btn icon" aria-label="Zoom in" disabled={!loaded || view.scale >= MAX_ZOOM} onClick={() => zoom(view.scale * 1.5)}>+</button>
      </div>
      {count > 1 && <>
        <button type="button" className="image-viewer-nav prev" aria-label="Previous image" onClick={() => onNavigate?.(-1)}>‹</button>
        <button type="button" className="image-viewer-nav next" aria-label="Next image" onClick={() => onNavigate?.(1)}>›</button>
        <div className="image-viewer-count">{current + 1} / {count}</div>
      </>}
      <button type="button" className="image-viewer-close" onClick={onClose} aria-label="Close">×</button>
    </div>, document.body,
  );
}
