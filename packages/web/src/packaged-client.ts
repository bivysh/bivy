// SPDX-License-Identifier: AGPL-3.0-only
// Generic native platform adapter. Deployment/product policy lives in the
// explicit client configuration, not in platform or URL detection.
import { clientConfiguration } from "./client-config.js";
export { accountExtensionFacts, showAccountExtension } from "./client-config.js";
export interface PackagedBridge {
  /** Hydrate storage from the native secure store before the controller exists. */
  ready(): Promise<void>;
  /** Synchronous hydrated view. Secret writes must be queued to secure storage,
   * never to localStorage; flush rejects if persistence failed. */
  storage: Storage;
  flush(): Promise<void>;
  openExternal(url: string): Promise<void>;
  onForeground(callback: () => void): () => void;
  onOpenURL?(callback: (url: string) => void): () => void;
  notifications?: {
    status(account: { token: string; controlPlane: string }): Promise<{ supported: boolean; subscribed: boolean; permission: string }>;
    enable(account: { token: string; controlPlane: string }): Promise<string>;
    disable(account: { token: string; controlPlane: string }): Promise<string>;
    synchronize(account: { token: string; controlPlane: string }): Promise<void>;
    clear(): Promise<void>;
  };
  /** Optional store-owned subscription management. Implemented by the native
   * host. Visibility of deployment-extension actions is configured separately. */
  accountSubscriptions?: {
    open(account: { token: string; controlPlane: string }): Promise<void>;
    synchronize(account: { token: string; controlPlane: string }): Promise<void>;
    clear(): Promise<void>;
  };
}

declare global {
  var __BIVY_PACKAGED_BRIDGE__: PackagedBridge | undefined;
}

export const packagedOrigin = clientConfiguration.controlPlaneOrigin;
export const isPackagedClient = clientConfiguration.platform === "native";
let initialized = false;

function bridge(): PackagedBridge {
  const value = globalThis.__BIVY_PACKAGED_BRIDGE__;
  if (!value) throw new Error("The packaged app requires its native secure-storage bridge.");
  return value;
}

async function nativeOperation<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native storage timed out.")), 15_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function initializePackagedClient(): Promise<void> {
  if (initialized || (!isPackagedClient && !packagedOrigin)) return;
  const native = isPackagedClient ? bridge() : undefined;
  if (native) await nativeOperation(native.ready());
  const storage = native?.storage ?? localStorage;
  // A native adapter must namespace storage by control-plane origin. Never
  // silently reuse another environment's bearer token after a build switch.
  const savedSession = storage.getItem("bivy_session");
  const previous = storage.getItem("bivy_cp") || (!native && savedSession ? location.origin : null);
  if ((previous || savedSession) && previous !== packagedOrigin) {
    throw new Error("This app's saved account belongs to a different server.");
  }
  storage.setItem("bivy_cp", packagedOrigin!);
  if (native) await nativeOperation(native.flush());
  initialized = true;
}

export function clientStorage(): Storage {
  if (!isPackagedClient) return localStorage;
  if (!initialized) throw new Error("Packaged client storage has not been initialized.");
  return bridge().storage;
}

export async function flushClientStorage(): Promise<void> {
  if (!isPackagedClient) return;
  try {
    await nativeOperation(bridge().flush());
  } catch {
    throw new Error("Could not save the account securely. Please try again.");
  }
}

export function accountOrigin(fallback = location.origin): string {
  return packagedOrigin ?? fallback;
}

export function onNativeForeground(callback: () => void): () => void {
  return isPackagedClient ? bridge().onForeground(callback) : () => {};
}

export async function openPackagedExternal(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Unsupported external URL.");
  await bridge().openExternal(parsed.href);
}

export function nativeNotifications() {
  return isPackagedClient ? bridge().notifications : undefined;
}
export async function clearNativeNotifications(): Promise<void> {
  const capability = nativeNotifications();
  if (capability) await nativeOperation(capability.clear());
}
export function onNativeOpenURL(callback: (url: string) => void): void {
  if (isPackagedClient) bridge().onOpenURL?.(callback);
}

export function hasNativeSubscriptions(): boolean {
  return isPackagedClient && Boolean(globalThis.__BIVY_PACKAGED_BRIDGE__?.accountSubscriptions);
}
export async function openNativeSubscriptions(token: string): Promise<void> {
  if (!token || !hasNativeSubscriptions()) throw new Error("Native subscriptions are unavailable.");
  await bridge().accountSubscriptions!.open({ token, controlPlane: packagedOrigin! });
}
export async function synchronizeNativeSubscriptions(token: string): Promise<void> {
  if (token && hasNativeSubscriptions()) await bridge().accountSubscriptions!.synchronize({ token, controlPlane: packagedOrigin! });
}
export async function clearNativeSubscriptions(): Promise<void> {
  if (hasNativeSubscriptions()) await nativeOperation(bridge().accountSubscriptions!.clear());
}

export function installPackagedNavigation(onError: (message: string) => void): void {
  if (!isPackagedClient) return;
  document.addEventListener("click", event => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    void openPackagedExternal(url.href).catch(() => onError("Could not open the external browser."));
  });
}

/** Account action URLs must not navigate privileged native WebViews. */
export async function openAccountAction(url: string): Promise<void> {
  if (isPackagedClient) await openPackagedExternal(url);
  else location.assign(url);
}
