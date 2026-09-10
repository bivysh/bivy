// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href],button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])';
const scopes: HTMLElement[] = [];
const backgrounds = new WeakMap<HTMLElement, { count: number; inert: boolean }>();

/** Shared modal keyboard boundary, including nested/portalled dialogs. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, initial?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>('[aria-modal="true"]') ?? ref.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    scopes.push(root);
    const hidden: HTMLElement[] = [];
    for (let child: HTMLElement = root; child.parentElement; child = child.parentElement) {
      for (const sibling of child.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === child || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue;
        const state = backgrounds.get(sibling) ?? { count: 0, inert: sibling.inert };
        state.count++;
        backgrounds.set(sibling, state);
        sibling.inert = true;
        hidden.push(sibling);
      }
      if (child.parentElement === document.body) break;
    }
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => !element.closest('[inert]') && element.getClientRects().length > 0);
    (initial?.current ?? controls()[0] ?? root).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || scopes.at(-1) !== root) return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) { event.preventDefault(); root.focus(); return; }
      if (!root.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      scopes.splice(scopes.indexOf(root), 1);
      for (const element of hidden) {
        const state = backgrounds.get(element)!;
        if (--state.count === 0) { element.inert = state.inert; backgrounds.delete(element); }
      }
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus();
    };
  }, [ref, initial]);
}
