// SPDX-License-Identifier: AGPL-3.0-only
// Explicit, build-time packaged companion profile. Never inferred from localhost
// or a query parameter; ordinary web/PWA and self-hosted builds are unchanged.
export interface PackagedBridge {
  /** Hydrate storage from the native secure store before the controller exists. */
  ready(): Promise<void>;
  /** Synchronous hydrated view. Secret writes must be queued to secure storage,
   * never to localStorage; flush rejects if persistence failed. */
  storage: Storage;
  flush(): Promise<void>;
  openExternal(url: string): Promise<void>;
  onForeground(callback: () => void): () => void;
}

declare global {
  var __BIVY_PACKAGED_BRIDGE__: PackagedBridge | undefined;
}

export function parsePackagedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("VITE_BIVY_PACKAGED_CP must be an HTTPS origin");
  }
  return url.origin;
}

export const packagedOrigin = parsePackagedOrigin(import.meta.env?.VITE_BIVY_PACKAGED_CP);
export const isPackagedClient = packagedOrigin !== null;
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
  if (!isPackagedClient || initialized) return;
  const native = bridge();
  await nativeOperation(native.ready());
  // A native adapter must namespace storage by control-plane origin. Never
  // silently reuse another environment's bearer token after a build switch.
  const previous = native.storage.getItem("bivy_cp");
  if ((previous || native.storage.getItem("bivy_session")) && previous !== packagedOrigin) {
    throw new Error("This app's saved account belongs to a different server.");
  }
  native.storage.setItem("bivy_cp", packagedOrigin!);
  await nativeOperation(native.flush());
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

/** The deployment extension is opaque: companion builds cannot safely infer
 * which server-supplied actions/facts advertise purchases. Hide that surface,
 * not the account's identity, devices, deletion, or repository integrations. */
export function showAccountExtension(packaged = isPackagedClient): boolean {
  return !packaged;
}

export function companionPolicyMessage(message: string, packaged = isPackagedClient): string {
  if (packaged && /\b(upgrade|subscribe|subscription|checkout|payment|purchase)\b/i.test(message)) {
    return "This operation is not available for this account.";
  }
  return message;
}
