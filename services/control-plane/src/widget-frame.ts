// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The frame chat widgets run in (packages/web/public/widget-frame.html), served
// with its own policy in place of the app's. The page carries the same policy
// as a meta tag, for servers that send none; the `sandbox` directive, which
// only a header can carry, puts it in an opaque origin however it is opened, so
// the agent-written page it loads can run inline script and use CDN libraries
// without ever reaching this origin's storage, cookies or API. It may not
// frame, submit forms or connect anywhere. It is framed by the app (and by
// native shells on their own origin), so the app's frame-ancestors and
// X-Frame-Options do not apply; the page itself refuses to do anything at the
// top level. See docs/widgets.md.
import type { Request, Response } from "express";

/** The policy to send with the page: its own meta policy, plus the sandbox
 *  directive only a header can carry. Throws when the page has no policy, so a
 *  frame without one is never served. */
export function widgetFramePolicy(html: string): string {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html)?.[1];
  if (!meta || !/connect-src 'none'/.test(meta)) throw new Error("widget-frame.html must carry its Content-Security-Policy meta tag");
  return `sandbox allow-scripts allow-forms; ${meta}`;
}

/** Serve the page from memory (read once at boot), so a request touches no file. */
export function serveWidgetFrame(html: Buffer) {
  const policy = widgetFramePolicy(html.toString("utf8"));
  return (_req: Request, res: Response) => {
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", policy);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(html);
  };
}
