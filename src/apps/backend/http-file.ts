// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** `.http` files: the request format VS Code's REST Client and JetBrains
 * already run, so an agent writes them fluently and they're useful without
 * Bivy. This reads the part of it a review needs:
 *
 *   @token = abc                    file variables, used as {{token}}
 *   ### Create order                a separator, and the request's name
 *   # @name create-order            or a name given this way
 *   # @auto                         run it before and after each agent run
 *   POST {{base}}/orders            method (default GET) and URL
 *   Content-Type: application/json  headers, until a blank line
 *
 *   { "items": [42] }               the body, until the next ###
 *
 * `{{base}}` is the app's server. Anything else (scripts, response handlers)
 * is left alone. */
export interface HttpRequestSpec { name: string; method: string; url: string; headers: [string, string][]; body: string; auto: boolean }

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const MAX_REQUESTS = 100;

export interface HttpFile { requests: HttpRequestSpec[]; variables: Record<string, string> }

export function parseHttpFile(text: string): HttpFile {
  const variables = new Map<string, string>();
  const requests: HttpRequestSpec[] = [];
  // Blocks between "###" lines; a block's first ### line may carry its name.
  const blocks: { title: string; lines: string[] }[] = [{ title: "", lines: [] }];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const separator = /^###\s*(.*)$/.exec(line);
    if (separator) blocks.push({ title: separator[1]!.trim(), lines: [] });
    else blocks.at(-1)!.lines.push(line);
  }
  for (const block of blocks) {
    let name = block.title, auto = false, at = 0;
    const lines = block.lines;
    // Before the request line: variables, comments and annotations.
    for (; at < lines.length; at++) {
      const line = lines[at]!.trim();
      if (!line) continue;
      const variable = /^@([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(line);
      if (variable) { variables.set(variable[1]!, variable[2]!.trim()); continue; }
      const comment = /^(?:#|\/\/)\s*(.*)$/.exec(line);
      if (comment) {
        const tag = /^@(\w+)\s*(.*)$/.exec(comment[1]!);
        if (tag?.[1] === "name" && tag[2]) name = tag[2].trim();
        if (tag?.[1] === "auto") auto = true;
        continue;
      }
      break;
    }
    if (at >= lines.length) continue;
    const first = lines[at]!.trim().split(/\s+/);
    const method = METHODS.includes(first[0]!.toUpperCase()) ? first.shift()!.toUpperCase() : "GET";
    const url = first[0] ?? "";
    if (!url) continue;
    const headers: [string, string][] = [];
    for (at++; at < lines.length && lines[at]!.trim(); at++) {
      const header = /^([^:\s]+)\s*:\s*(.*)$/.exec(lines[at]!.trim());
      if (header) headers.push([header[1]!, header[2]!]);
    }
    const body = lines.slice(at + 1).join("\n").replace(/\s+$/, "");
    requests.push({ name: name || `${method} ${url}`, method, url, headers, body, auto });
    if (requests.length >= MAX_REQUESTS) break;
  }
  // Variables apply wherever they were declared in the file, like the editors do.
  return { requests, variables: Object.fromEntries(variables) };
}

/** A request with its variables put in; `given` (like `base`) wins over the file's. */
export function resolveRequest(spec: HttpRequestSpec, variables: Record<string, string>, given: Record<string, string>): { method: string; url: string; headers: [string, string][]; body: string } {
  const fill = (value: string) => value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => given[key] ?? variables[key] ?? match);
  return { method: spec.method, url: fill(spec.url), headers: spec.headers.map(([key, value]) => [key, fill(value)]), body: fill(spec.body) };
}
