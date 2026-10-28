// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The check a widget gets even where no browser is installed: every classic
// inline <script> must parse. One syntax error stops a page's whole script, so
// a widget that looks right does nothing; agents write these by hand, and this
// is the mistake they make. Line numbers are the file's, so the agent can go
// straight to it. Module scripts and data blocks are left to the browser.
import vm from "node:vm";

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;
const CLASSIC = /^\s*$|^\s*(?:text|application)\/(?:java|ecma)script\s*$/i;

export function checkWidgetScripts(html: string, name = "widget"): string[] {
  const errors: string[] = [];
  for (const match of html.matchAll(SCRIPT)) {
    const attrs = match[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? "";
    if (!CLASSIC.test(type)) continue;
    const code = match[2] ?? "";
    // The line the script's code starts on, counted in the whole file.
    const startLine = html.slice(0, (match.index ?? 0) + match[0].indexOf(">") + 1).split("\n").length;
    try {
      new vm.Script(code, { filename: name, lineOffset: startLine - 1 });
    } catch (error) {
      const line = /:(\d+)\n/.exec(String((error as Error).stack ?? ""))?.[1];
      errors.push(`${(error as Error).name}: ${(error as Error).message}${line ? ` (${name} line ${line})` : ""}`);
    }
  }
  return errors;
}
