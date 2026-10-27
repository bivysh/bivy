// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

export type InboxSeverity = "info" | "warning" | "error" | "critical";

/** Content-free attention metadata safe to publish in a session advert. */
export interface InboxAdvert {
  id: string;
  kind: "approval" | "question" | "session" | "automation";
  severity: InboxSeverity;
  createdAt: string;
  updatedAt?: string;
}
