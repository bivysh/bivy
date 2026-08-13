// SPDX-License-Identifier: AGPL-3.0-only

export type SessionDateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Older";

/** Stable calendar grouping for the session drawer. Attention is handled by the
 * caller because it is product state, while this helper owns date boundaries. */
export function sessionDateGroup(value: number | string | undefined, now = new Date()): SessionDateGroup {
  if (value == null) return "Older";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Older";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  return "Older";
}
