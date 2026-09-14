// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Activate the worker captured at click time, not a stale UI availability flag.
 * No waiting worker means another tab may already have activated it: the caller
 * must still reload. Await activation before navigating into the new precache. */
export async function activateWaitingWorker(
  registration: Pick<ServiceWorkerRegistration, "waiting"> | undefined,
  timeoutMs = 15_000,
): Promise<void> {
  const worker = registration?.waiting;
  if (!worker || worker.state === "activated") return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", onStateChange);
      if (error) reject(error);
      else resolve();
    };
    const onStateChange = () => {
      if (worker.state === "activated") finish();
      else if (worker.state === "redundant") finish(new Error("The update was replaced. Please try Reload again."));
    };
    const timer = setTimeout(() => finish(new Error("The update did not activate. Please try Reload again.")), timeoutMs);
    worker.addEventListener("statechange", onStateChange);
    try {
      worker.postMessage({ type: "SKIP_WAITING" });
      onStateChange();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
