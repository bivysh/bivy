// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The frame chat widgets run in (packages/web/public/widget-frame.html), served
// with its own policy in place of the app's. The `sandbox` directive puts the
// page in an opaque origin however it is opened, so the agent-written page it
// loads can run inline script and use CDN libraries without ever reaching this
// origin's storage, cookies or API. It may not frame, submit forms or connect
// anywhere. It is framed by the app (and by native shells on their own origin),
// so the app's frame-ancestors/X-Frame-Options do not apply; the page itself
// refuses to do anything at the top level. See docs/widgets.md.
import type { Request, Response } from "express";

export const WIDGET_FRAME_POLICY = [
  "sandbox allow-scripts allow-forms",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export function serveWidgetFrame(file: string) {
  return (_req: Request, res: Response) => {
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", WIDGET_FRAME_POLICY);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.sendFile(file);
  };
}
