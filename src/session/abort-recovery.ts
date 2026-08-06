// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Settle Bivy's view of a turn before asking the runtime to abort it.
 *
 * Runtime aborts are deliberately best-effort: an in-process SDK can be wedged
 * in the very operation abort is meant to interrupt.  Stop must therefore not
 * await that SDK before the client is allowed to leave its working state.
 */
export function forceAbortTurn(options: {
  settle: () => void;
  notifySettled: () => void;
  abort: () => Promise<void>;
  onAbortError?: (error: unknown) => void;
}): void {
  options.settle();
  options.notifySettled();
  void Promise.resolve()
    .then(options.abort)
    .catch((error) => options.onAbortError?.(error));
}
