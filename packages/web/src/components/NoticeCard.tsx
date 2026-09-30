// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// A message the agent sent with `bivy notify`: the text the push notification
// pointed at (the push itself names only the session).
import type { AgentNotice } from "@bivy/core";
import { Badge } from "./Badge.js";

export function NoticeCard({ notice }: { notice: AgentNotice }) {
  return (
    <section className="card notice-card" data-tone={notice.urgent ? "warn" : "accent"} aria-label={notice.urgent ? "Urgent message from the agent" : "Message from the agent"}>
      <p className="notice-eyebrow">
        Message for you
        {notice.urgent && <Badge tone="warn" variant="soft">Urgent</Badge>}
      </p>
      <p className="notice-text">{notice.text}</p>
    </section>
  );
}
