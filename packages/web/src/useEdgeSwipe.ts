// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef } from "react";

interface EdgeSwipeOpts {
  /** Called by a rightward swipe that starts within `edge` px of the left side. */
  onOpen: () => void;
  /** Called by a leftward swipe while the drawer is open. */
  onClose: () => void;
  /** True while the drawer is open (enables the close gesture, disables open). */
  isOpen: boolean;
  /** Only fire below this viewport width (the drawer is permanent above it). */
  maxWidth?: number;
  /** How close to the left edge an opening swipe must start. */
  edge?: number;
  /** Horizontal distance that commits the gesture. */
  threshold?: number;
}

/**
 * Left-edge swipe to open the sidebar drawer (and swipe-left to close it),
 * matching the native-app gesture. Tracks a single touch and commits only when
 * the motion is dominantly horizontal, so it never fights vertical scrolling.
 */
export function useEdgeSwipe({ onOpen, onClose, isOpen, maxWidth = 720, edge = 28, threshold = 60 }: EdgeSwipeOpts): void {
  // Keep the latest callbacks in a ref so App can pass fresh inline closures
  // without tearing down and re-adding the touch listeners on every render.
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let fromEdge = false;
    // Once a move is confirmed to be a horizontal drawer gesture we keep
    // calling preventDefault so the browser never claims it as an
    // edge-swipe "back" navigation.
    let claimed = false;

    const start = (e: TouchEvent) => {
      claimed = false;
      if (e.touches.length !== 1 || window.innerWidth > maxWidth) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      if (!t) {
        tracking = false;
        return;
      }
      startX = t.clientX;
      startY = t.clientY;
      fromEdge = startX <= edge;
      // Track when either opening from the edge, or closing while open.
      tracking = fromEdge || isOpen;
    };

    const move = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!claimed) {
        // A vertical-dominant move is a scroll — stop tracking and let the
        // browser handle it (never preventDefault a scroll).
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 6) {
          tracking = false;
          return;
        }
        // Claim on the very first hint of horizontal intent. Waiting even a
        // few pixels lets the platform (notably an iOS PWA) commit to its
        // native edge-swipe "back" navigation before we can suppress it, so
        // the gesture would both open the drawer AND navigate back. For an
        // edge-originating swipe we claim in either direction so the system
        // back/forward gesture is fully suppressed; while open we only need
        // the leftward close direction.
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 2) {
          if ((!isOpen && fromEdge) || (isOpen && dx < 0)) claimed = true;
        }
      }
      if (claimed && e.cancelable) e.preventDefault();
    };

    const end = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      claimed = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) <= Math.abs(dy) || Math.abs(dx) < threshold) return; // not a horizontal swipe
      if (!isOpen && fromEdge && dx > 0) onOpenRef.current();
      else if (isOpen && dx < 0) onCloseRef.current();
    };

    window.addEventListener("touchstart", start, { passive: true });
    // Non-passive so preventDefault can suppress the browser back gesture.
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end, { passive: true });
    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
    };
  }, [isOpen, maxWidth, edge, threshold]);
}
