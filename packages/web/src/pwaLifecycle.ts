// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

export type InstallChoice = "native" | "ios" | "safari" | null;

export interface PwaLifecycleState {
  updateAvailable: boolean;
  installChoice: InstallChoice;
  standalone: boolean;
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
const listeners = new Set<() => void>();
let installEvent: BeforeInstallPromptEvent | null = null;

function storedFirstSuccess(): boolean {
  try { return localStorage.getItem(FIRST_SUCCESS_KEY) === "1"; } catch { return false; }
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function fallbackInstallChoice(): InstallChoice {
  if (typeof navigator === "undefined" || isStandalone()) return null;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) return "ios";
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS/.test(ua);
  return safari ? "safari" : null;
}

let state: PwaLifecycleState = {
  updateAvailable: false,
  installChoice: null,
  standalone: isStandalone(),
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
  publish({ standalone, installChoice: standalone || !state.firstSuccess ? null : installEvent ? "native" : fallbackInstallChoice() });
}

export function initializeInstallLifecycle(): () => void {
  const onPrompt = (event: Event) => {
    event.preventDefault();
    installEvent = event as BeforeInstallPromptEvent;
    refreshInstallChoice();
  };
  const onInstalled = () => { installEvent = null; publish({ standalone: true, installChoice: null }); };
  const media = window.matchMedia?.("(display-mode: standalone)");
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  media?.addEventListener?.("change", refreshInstallChoice);
  refreshInstallChoice();
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
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

export function markPromptQueued(): void { publish({ locallyQueuedPrompts: state.locallyQueuedPrompts + 1 }); }
export function clearQueuedPrompts(): void { publish({ locallyQueuedPrompts: 0 }); }

export function markFirstSuccessfulResponse(): void {
  try { localStorage.setItem(FIRST_SUCCESS_KEY, "1"); } catch {}
  publish({ firstSuccess: true });
  refreshInstallChoice();
}

export async function requestInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = installEvent;
  if (!event || state.standalone || !state.firstSuccess) return "unavailable";
  installEvent = null;
  publish({ installChoice: null });
  await event.prompt();
  const choice = await event.userChoice;
  if (choice.outcome === "dismissed") refreshInstallChoice();
  return choice.outcome;
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
