// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

/**
 * True when a key event belongs to an input method (IME) composition: the
 * Enter that confirms a Japanese/Chinese/Korean candidate, say. Such a key must
 * never send or submit. Chrome and Firefox flag it with `isComposing`; Safari
 * fires the confirming Enter after `compositionend` with only `keyCode` 229.
 */
export function isImeKey(event: { nativeEvent?: KeyboardEvent; keyCode?: number; isComposing?: boolean }): boolean {
  const native = event.nativeEvent ?? event;
  return Boolean(native.isComposing) || native.keyCode === 229;
}
