// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Shared images (a screenshot from Photos, the OS share sheet) arrive as a
// multipart POST to /share, which only the service worker can read. It keeps
// them in this device's Cache Storage under a one-time id and sends the app to
// `/share?shared=<id>` (a GET, served from the precached shell — the bytes never
// reach a server). The page then offers a destination and hands the images to
// that session's composer as ordinary attachments: nothing is sent until the
// user sends it, and then over the session's encrypted channel like any image.

/** A shared image as the composer takes it (a PromptAttachment). Declared
 *  here so the service worker's build doesn't pull in the app's types. */
export interface SharedImage { kind: "image"; name: string; mimeType: string; size: number; data: string }

export const SHARE_INBOX = "bivy-share-inbox";
/** Images per share, and bytes in total — a phone screenshot is a few MB. */
const MAX_FILES = 6;
const MAX_BYTES = 30 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;

interface Meta { title: string; text: string; url: string; files: { name: string; type: string; size: number }[] }
const key = (id: string, part: string | number) => `/__share-inbox/${id}/${part}`;
const field = (form: FormData, name: string) => { const value = form.get(name); return typeof value === "string" ? value.slice(0, 20_000) : ""; };

/** Service-worker side: keep a share POST and return where to send the app. */
export async function receiveShare(request: Request, storage: CacheStorage): Promise<string> {
  const form = await request.formData();
  let total = 0;
  const files = form.getAll("files").filter((item): item is File => typeof item !== "string" && item.type.startsWith("image/"))
    .filter((file) => (total += file.size) <= MAX_BYTES).slice(0, MAX_FILES);
  const meta: Meta = { title: field(form, "title"), text: field(form, "text"), url: field(form, "url"),
    files: files.map((file, i) => ({ name: (file.name || `shared-${i + 1}`).slice(0, 200), type: file.type, size: file.size })) };
  if (!files.length) return `/share?${new URLSearchParams({ title: meta.title, text: meta.text, url: meta.url })}`;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const cache = await storage.open(SHARE_INBOX);
  await Promise.all(files.map((file, i) => cache.put(key(id, i), new Response(file, { headers: { "content-type": file.type } }))));
  await cache.put(key(id, "meta"), new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }));
  return `/share?shared=${id}`;
}

export interface SharedItems { text: string; attachments: SharedImage[] }

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Page side: a kept share's text and images, or null when it's gone. It
 *  stays kept until `dropShare`, so a sign-in reload doesn't lose it. */
export async function readShare(id: string, storage: CacheStorage | undefined = globalThis.caches): Promise<SharedItems | null> {
  if (!ID.test(id) || !storage) return null;
  const cache = await storage.open(SHARE_INBOX);
  const meta = await cache.match(key(id, "meta")).then((r) => r?.json() as Promise<Meta> | undefined).catch(() => undefined);
  if (!meta) return null;
  const attachments: SharedImage[] = [];
  for (const [i, file] of meta.files.entries()) {
    const response = await cache.match(key(id, i));
    if (!response) continue;
    const data = base64(await response.arrayBuffer());
    attachments.push({ kind: "image", name: file.name, mimeType: file.type, size: file.size, data });
  }
  const parts = [meta.title.trim(), meta.text.trim()];
  if (meta.url && !parts.some((part) => part.includes(meta.url))) parts.push(meta.url.trim());
  return { text: parts.filter(Boolean).join("\n"), attachments };
}

export async function dropShare(id: string, storage: CacheStorage | undefined = globalThis.caches): Promise<void> {
  if (!ID.test(id) || !storage) return;
  const cache = await storage.open(SHARE_INBOX);
  for (const request of await cache.keys()) if (new URL(request.url).pathname.startsWith(`/__share-inbox/${id}/`)) await cache.delete(request);
}
