// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, type RefObject } from "react";

function resize(input: HTMLTextAreaElement) {
  if (!input.parentElement || !input.clientWidth) return;
  const style = getComputedStyle(input);
  // Never collapse the live textarea to measure it. That temporarily shortens
  // its scroll container, clamping scrollTop and moving the caret off screen
  // on every keystroke (especially with the iOS keyboard open).
  const measure = input.cloneNode(false) as HTMLTextAreaElement;
  measure.removeAttribute("id");
  measure.removeAttribute("name");
  measure.setAttribute("aria-hidden", "true");
  measure.tabIndex = -1;
  measure.value = input.value;
  Object.assign(measure.style, {
    position: "fixed", visibility: "hidden", pointerEvents: "none",
    width: style.width, height: "0", minHeight: "0", maxHeight: "none",
  });
  // Keep the same styling context, without putting the measuring copy in flow.
  input.parentElement.append(measure);
  const height = measure.scrollHeight + (style.boxSizing === "border-box"
    ? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    : -parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
  measure.remove();
  input.style.height = `${height}px`;
}

/** Grow and shrink without disturbing the browser's native caret scrolling. */
export function useAutoGrowingTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    if (ref.current) resize(ref.current);
  }, [ref, value]);

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize(input);
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [ref]);
}
