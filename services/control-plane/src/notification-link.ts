// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where a push notification opens: the SPA session route (`/sessions/:id`),
 * carrying the owning node so a tap can switch to it first. Optional targets
 * inside the session are IDs only, each checked against its exact shape, so a
 * node's hint can't smuggle anything else into the URL:
 *  - `attention`: an approval or question card;
 *  - `review`: a run's review card (never the screenshot itself);
 *  - `apps`: the Apps sheet at one app, for reviewer notes (never the note text).
 * Without a session there is only the root.
 */
export function notificationLink(input: { nodeId: string; kind: string; sessionId?: string; attentionId?: string; review?: unknown; apps?: unknown }): { url: string; review: boolean } {
  if (!input.sessionId) return { url: "/", review: false };
  const review = input.review as { reviewId?: unknown } | undefined;
  const reviewId = typeof review?.reviewId === "string" && /^review-[a-f0-9]{16}$/.test(review.reviewId) ? review.reviewId : "";
  const apps = input.apps as { appId?: unknown } | undefined;
  const appsId = input.kind === "app_notes" && typeof apps?.appId === "string" && /^[a-f0-9]{32}$/.test(apps.appId) ? apps.appId : "";
  const url = `/sessions/${encodeURIComponent(input.sessionId)}?node=${encodeURIComponent(input.nodeId)}`
    + (input.attentionId ? `&attention=${encodeURIComponent(input.attentionId)}` : "")
    + (reviewId ? `&review=${reviewId}` : "")
    + (appsId ? `&apps=${appsId}` : "");
  return { url, review: Boolean(reviewId) };
}
