// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Results for the composer's @ picker: asks the session's machine for files
// matching the query (`files.search`), a beat after typing stops. The node's
// error reply rejects, and its reason is shown in the picker.

import { useEffect, useState } from "react";
import { controller } from "./store/useStore.js";

export interface FileSearchEntry { path: string; type: "dir" | "file" }

export type FileSearch =
  | { status: "idle" }
  | { status: "loading"; entries: FileSearchEntry[] }
  | { status: "done"; entries: FileSearchEntry[] }
  | { status: "error"; error: string };

const DEBOUNCE_MS = 120;

/** `query` null: the picker is closed. */
export function useFileSearch(sessionId: string | undefined, query: string | null): FileSearch {
  const [result, setResult] = useState<FileSearch>({ status: "idle" });
  useEffect(() => {
    if (!sessionId || query === null) { setResult({ status: "idle" }); return; }
    // Keep showing the previous matches while the next ones load.
    setResult((prev) => ({ status: "loading", entries: prev.status === "done" || prev.status === "loading" ? prev.entries : [] }));
    let live = true;
    const timer = setTimeout(() => {
      controller.searchFiles(sessionId, query).then((event) => {
        if (!live) return;
        const entries = (event as { entries?: unknown }).entries;
        setResult({ status: "done", entries: Array.isArray(entries) ? entries as FileSearchEntry[] : [] });
      }, (error: unknown) => {
        if (live) setResult({ status: "error", error: error instanceof Error ? error.message : "Couldn't search this session's files." });
      });
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [sessionId, query]);
  return result;
}
