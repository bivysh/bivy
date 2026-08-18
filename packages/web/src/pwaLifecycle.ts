// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import type { ConnectionStatus } from "@bivy/core";

export type InstallChoice = "native" | "ios" | "safari" | null;
export type AvailabilityKind =
  | "live-control"
  | "local-queue"
  | "reconnecting"
  | "cached-transcript"
  | "cached-shell"
  | "offline-page";

export interface AvailabilityMessage {
  kind: AvailabilityKind;
  label: string;
  detail: string;
}

export interface PwaLifecycleState {
  updateAvailable: boolean;
  installChoice: InstallChoice;
  standalone: boolean;
  shellCached: boolean;
  firstSuccess: boolean;
  hasDraft: boolean;
  pendingAttachments: number;
  readingAttachments: boolean;
  turnActive: boolean;
  locallyQueuedPrompts: number;
}

type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const FIRST_SUCCESS_KEY = "bivy.pwa.first-success";
const LEGACY_FIRST_SUCCESS_KEY = "bivy.product-metric.first_useful_response";
const INSTALL_DISMISSED_KEY = "bivy.pwa.install-dismissed";
const listeners = new Set<() => void>();
let installEvent: BeforeInstallPromptEvent | null = null;
let installedThisRun = false;
let installDismissed = false;
let reconnectQueuedPrompts = 0;
let followupQueuedPrompts = 0;

function storedFirstSuccess(): boolean {
  try {
    return localStorage.getItem(FIRST_SUCCESS_KEY) === "1" || localStorage.getItem(LEGACY_FIRST_SUCCESS_KEY) === "1";
  } catch {
    return false;
  }
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function storedInstallDismissal(): boolean {
  try { return localStorage.getItem(INSTALL_DISMISSED_KEY) === "1"; } catch { return false; }
}

installDismissed = typeof window !== "undefined" && storedInstallDismissal();

/** Browser-family fallback used only when the native install event is absent. */
export function fallbackInstallChoice(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
  standalone = false,
): InstallChoice {
  if (standalone) return null;
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  if (ios) return "ios";
  const safari = /Safari/.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS/.test(userAgent);
  return safari ? "safari" : null;
}

function browserFallbackInstallChoice(): InstallChoice {
  if (typeof navigator === "undefined") return null;
  return fallbackInstallChoice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints, isStandalone());
}

let state: PwaLifecycleState = {
  updateAvailable: false,
  installChoice: null,
  standalone: isStandalone(),
  shellCached: false,
  firstSuccess: typeof window !== "undefined" && storedFirstSuccess(),
  hasDraft: false,
  pendingAttachments: 0,
  readingAttachments: false,
  turnActive: false,
  locallyQueuedPrompts: 0,
};

function publish(patch: Partial<PwaLifecycleState>): void {
  const next = { ...state, ...patch };
  if (Object.keys(next).every((key) => next[key as keyof PwaLifecycleState] === state[key as keyof PwaLifecycleState])) return;
  state = next;
  listeners.forEach((listener) => listener());
}

function refreshInstallChoice(): void {
  const standalone = isStandalone();
  publish({
    standalone,
    installChoice: standalone || installedThisRun || installDismissed || !state.firstSuccess
      ? null
      : installEvent ? "native" : browserFallbackInstallChoice(),
  });
}

async function refreshShellCache(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    publish({ shellCached: Boolean(registration?.active) });
  } catch {
    publish({ shellCached: false });
  }
}

export function initializeInstallLifecycle(): () => void {
  const onPrompt = (event: Event) => {
    event.preventDefault();
    installEvent = event as BeforeInstallPromptEvent;
    refreshInstallChoice();
  };
  const onInstalled = () => {
    installEvent = null;
    installedThisRun = true;
    refreshInstallChoice();
  };
  const onControllerChange = () => { void refreshShellCache(); };
  const media = window.matchMedia?.("(display-mode: standalone)");
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
  media?.addEventListener?.("change", refreshInstallChoice);
  refreshInstallChoice();
  void refreshShellCache();
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
    navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
    media?.removeEventListener?.("change", refreshInstallChoice);
  };
}

export function subscribePwaLifecycle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPwaLifecycleState(): PwaLifecycleState { return state; }

export function setUpdateAvailable(available: boolean): void { publish({ updateAvailable: available }); }

export function setComposerLifecycle(activity: Pick<PwaLifecycleState, "hasDraft" | "pendingAttachments" | "readingAttachments">): void {
  publish(activity);
}

export function setTurnActive(turnActive: boolean): void { publish({ turnActive }); }

function publishQueuedPrompts(): void {
  publish({ locallyQueuedPrompts: reconnectQueuedPrompts + followupQueuedPrompts });
}

/** Track prompts buffered by a reconnecting transport until it returns online. */
export function markPromptQueued(): void {
  reconnectQueuedPrompts += 1;
  publishQueuedPrompts();
}

export function clearQueuedPrompts(): void {
  reconnectQueuedPrompts = 0;
  publishQueuedPrompts();
}

/** Track the controller's visible in-memory follow-up queues across Sessions. */
export function setFollowupQueuedPrompts(count: number): void {
  followupQueuedPrompts = Math.max(0, Math.floor(count));
  publishQueuedPrompts();
}

export function markFirstSuccessfulResponse(): void {
  try { localStorage.setItem(FIRST_SUCCESS_KEY, "1"); } catch {}
  publish({ firstSuccess: true });
  refreshInstallChoice();
}

/** Permanently hide the optional install suggestion on this browser profile. */
export function dismissInstall(): void {
  installDismissed = true;
  installEvent = null;
  try { localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch {}
  publish({ installChoice: null });
}

export async function requestInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = installEvent;
  if (!event || state.standalone || !state.firstSuccess) return "unavailable";
  installEvent = null;
  publish({ installChoice: null });
  try {
    await event.prompt();
    const choice = await event.userChoice;
    // A beforeinstallprompt event is one-shot. A dismissal stays hidden until
    // the browser decides the app is eligible again and emits a fresh event.
    return choice.outcome;
  } catch {
    return "unavailable";
  }
}

export function updateBlockers(value = state): string[] {
  const blockers: string[] = [];
  if (value.turnActive) blockers.push("the active turn finishes");
  if (value.readingAttachments) blockers.push("file reading finishes");
  if (value.hasDraft) blockers.push("the unsent draft is sent or cleared");
  if (value.pendingAttachments) blockers.push("pending attachments are sent or cleared");
  if (value.locallyQueuedPrompts) blockers.push("locally queued prompts reach the Machine");
  return blockers;
}

export function canActivateUpdate(value = state): boolean {
  return value.updateAvailable && updateBlockers(value).length === 0;
}

/** The one thing a user can actually do about an unreachable Machine. */
export const OFFLINE_MACHINE_HINT = "On that machine, run `bivy status` (or `bivy restart`).";

/** Pure copy model so every availability state remains independently testable.
 *  `machineName` (the connected node's name, when known) makes the notice say
 *  *which* Machine is unreachable instead of a generic "the Machine". */
export function describeAvailability(
  status: ConnectionStatus,
  hasCachedTranscript: boolean,
  value = state,
  machineName?: string,
): AvailabilityMessage {
  const who = machineName ? `Machine ${machineName}` : "The Machine";
  if (value.locallyQueuedPrompts > 0) {
    return {
      kind: "local-queue",
      label: value.locallyQueuedPrompts === 1 ? "Prompt queued on this device" : `${value.locallyQueuedPrompts} prompts queued on this device`,
      detail: `Not yet delivered to ${machineName ? `Machine ${machineName}` : "the Machine"}. Keep Bivy open — it sends as soon as the connection is back.`,
    };
  }
  if (status === "reconnecting" || status === "connecting" || status === "linking" || status === "pairing") {
    return {
      kind: "reconnecting",
      label: machineName ? `Reconnecting to ${machineName}` : "Reconnecting Machine",
      detail: hasCachedTranscript
        ? "Showing the cached transcript. Keep drafting — sending resumes once the connection is back."
        : `Waiting for ${machineName ? `Machine ${machineName}` : "the Machine"} to answer. If this sticks, run \`bivy status\` on that machine.`,
    };
  }
  if (status === "offline" && hasCachedTranscript) {
    return {
      kind: "cached-transcript",
      label: "Cached transcript",
      detail: `${who} is offline — this copy may be behind, and prompts can't send until it reconnects. ${OFFLINE_MACHINE_HINT}`,
    };
  }
  if (status === "offline" && value.shellCached) {
    return {
      kind: "cached-shell",
      label: "Machine offline",
      detail: `${who} is offline, so there is no transcript or live control yet. Your draft is kept here. ${OFFLINE_MACHINE_HINT}`,
    };
  }
  if (status === "offline") {
    return {
      kind: "offline-page",
      label: "Offline",
      detail: `${who} is unreachable. Your draft is kept on this device. ${OFFLINE_MACHINE_HINT}`,
    };
  }
  return {
    kind: "live-control",
    label: "Live control",
    detail: `${who} is connected. Prompts send now and transcript changes sync live.`,
  };
}
