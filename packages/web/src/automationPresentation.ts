// SPDX-License-Identifier: AGPL-3.0-only

/** Compact, human-readable date copy for automation lists. Exact timestamps
 * belong in the automation detail/editor, not in the overview. */
export function formatAutomationMoment(
  value: string | number | Date,
  options: { now?: Date; locale?: string } = {},
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";

  const now = options.now ?? new Date();
  const locale = options.locale;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDelta = Math.round((target.getTime() - start.getTime()) / 86_400_000);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);

  if (dayDelta === 0) return `Today at ${time}`;
  if (dayDelta === 1) return `Tomorrow at ${time}`;
  if (dayDelta === -1) return `Yesterday at ${time}`;
  if (dayDelta > 1 && dayDelta < 7) {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
    return `${weekday} at ${time}`;
  }

  const calendarDate = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
  return `${calendarDate} at ${time}`;
}

export function formatNextAutomationRun(
  value: string | number | Date,
  options: { now?: Date; locale?: string } = {},
): string {
  const moment = formatAutomationMoment(value, options)
    .replace(/^Today/, "today")
    .replace(/^Tomorrow/, "tomorrow");
  // A recurring schedule already states its time (for example “Daily at
  // 12:00”). Repeat the time only when the next run is today, where it helps.
  return `Next ${moment.startsWith("today") ? moment : moment.replace(/ at .+$/, "")}`;
}

/** Concise copy for the common cron shapes created by the UI. More complex cron
 * expressions fall back to cronstrue in the caller. */
export function compactCronSummary(expression: string, locale?: string): string | null {
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = expression.trim().split(/\s+/);
  if (rest.length || !/^\d+$/.test(minute || "") || !/^\d+$/.test(hour || "")) return null;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59 || month !== "*") return null;
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" })
    .format(new Date(2020, 0, 1, h, m));

  if (dayOfMonth === "*" && dayOfWeek === "*") return `Daily at ${time}`;
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek || "")) {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" })
      .format(new Date(2020, 0, 5 + Number(dayOfWeek)));
    return `Every ${weekday} at ${time}`;
  }
  if (/^\d+$/.test(dayOfMonth || "") && dayOfWeek === "*") return `Monthly on day ${Number(dayOfMonth)} at ${time}`;
  return null;
}
