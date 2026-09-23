// SPDX-License-Identifier: AGPL-3.0-only
/** Treat native delivery as untrusted input, never as a navigation command. */
export function nativeSessionLink(input: string, origin: string): { path: string; node: string | null } | null {
  try {
    if (input.length > 2048) return null;
    const url = new URL(input);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) return null;
    if (!/^\/(?:sessions|runs)\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.pathname === "/sessions/new") return null;
    if ([...url.searchParams.keys()].some(key => key !== "node") || url.searchParams.getAll("node").length > 1) return null;
    const node = url.searchParams.get("node");
    if (node !== null && (!url.pathname.startsWith('/sessions/') || !/^[A-Za-z0-9_-]+$/.test(node))) return null;
    return { path: url.pathname, node };
  } catch { return null; }
}
