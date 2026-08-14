// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

export type PresentationEventData = Readonly<Record<string, unknown>> & { type?: unknown };

export interface PresentationFoldValue {
  readonly githubApp: object | null;
  readonly prRefreshAllResult: object | null;
}

export interface PresentationFoldResult<T> {
  handled: boolean;
  value: T;
}

/** Fold transient result/progress events. No timers, effects, or store identity. */
export function foldPresentationEvent<T extends PresentationFoldValue>(value: T, event: PresentationEventData): PresentationFoldResult<T> {
  if (event.type === "sessions.pr_refresh_result") {
    return { handled: true, value: { ...value, prRefreshAllResult: {
      scanned: Number(event.scanned) || 0,
      changed: Number(event.changed) || 0,
      error: event.ok === false ? String(event.error || "Could not refresh GitHub status") : undefined,
    } } };
  }
  const prior = (value.githubApp || { phase: "idle" }) as Readonly<Record<string, unknown>>;
  if (event.type === "github.app.manifest.ready") {
    return { handled: true, value: { ...value, githubApp: {
      ...prior, phase: "submitting",
      action: typeof event.action === "string" ? event.action : undefined,
      manifest: event.manifest && typeof event.manifest === "object" ? event.manifest : undefined,
      state: typeof event.state === "string" ? event.state : undefined,
      error: undefined,
    } } };
  }
  if (event.type === "github.app.manifest.done") {
    return { handled: true, value: { ...value, githubApp: {
      ...prior, phase: "done",
      installUrl: typeof event.installUrl === "string" ? event.installUrl : undefined,
      error: undefined, returning: false,
    } } };
  }
  if (event.type === "github.app.manifest.error") {
    return { handled: true, value: { ...value, githubApp: {
      ...prior, phase: "error",
      error: typeof event.error === "string" ? event.error : "GitHub App setup failed.",
      returning: false,
    } } };
  }
  return { handled: false, value };
}
