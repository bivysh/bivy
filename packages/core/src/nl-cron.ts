// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A small, dependency-free natural-language → cron translator for the
// Automations schedule UI. It turns everyday English ("every day at 1pm",
// "weekdays at 8:30am", "every 15 minutes", "mondays and thursdays at 6am")
// into a STANDARD five-field Unix cron expression:
//
//     minute  hour  day-of-month  month  day-of-week
//
// Five fields (not the Quartz 6/7-field seconds+year variant) is deliberate:
// the control plane validates and schedules with `cron-parser`, which rejects
// Quartz-only tokens like `?`, `L`, and a trailing year (see
// services/control-plane/src/schedule.ts). The web UI shows the result back to
// the user rendered human-readable via `cronstrue`, so a mis-parse is visible
// before they save — this parser only needs to cover the common phrasings well
// and bail out clearly on anything it doesn't understand.

export interface NlCronOk {
  cron: string;
  /** The individual five fields, handy for tests and previews. */
  fields: { minute: string; hour: string; dom: string; month: string; dow: string };
}
export interface NlCronErr {
  error: string;
}
export type NlCronResult = NlCronOk | NlCronErr;

const DOW: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

interface Time { h: number; m: number }

/** Extract every explicit clock time in the phrase (noon/midnight/`1pm`/`13:30`). */
function extractTimes(text: string): Time[] {
  const times: Time[] = [];
  const seen = new Set<string>();
  const push = (h: number, m: number) => {
    if (h < 0 || h > 23 || m < 0 || m > 59) return;
    const key = `${h}:${m}`;
    if (!seen.has(key)) { seen.add(key); times.push({ h, m }); }
  };

  if (/\bnoon\b/.test(text)) push(12, 0);
  if (/\bmidnight\b/.test(text)) push(0, 0);

  // 12-hour clock with am/pm: "1pm", "1:30 pm", "at 9 am".
  for (const mtc of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/g)) {
    let h = Number(mtc[1]);
    const m = mtc[2] ? Number(mtc[2]) : 0;
    if (h === 12) h = 0; // 12am → 0, 12pm handled by the +12 below
    if (mtc[3] === "pm") h += 12;
    push(h, m);
  }
  // 24-hour clock: "13:30", "08:00". Skip anything already consumed as am/pm by
  // requiring it not be immediately followed by am/pm.
  for (const mtc of text.matchAll(/\b(\d{1,2}):(\d{2})\b(?!\s*(?:am|pm))/g)) {
    push(Number(mtc[1]), Number(mtc[2]));
  }
  return times.sort((a, b) => a.h - b.h || a.m - b.m);
}

/** Collect day-of-week numbers named in the phrase, plus weekday/weekend. */
function extractDows(text: string): number[] {
  const set = new Set<number>();
  if (/\b(weekday|weekdays|every weekday|business day|business days)\b/.test(text)) {
    [1, 2, 3, 4, 5].forEach((d) => set.add(d));
  }
  if (/\b(weekend|weekends)\b/.test(text)) {
    [0, 6].forEach((d) => set.add(d));
  }
  for (const mtc of text.matchAll(/\b([a-z]+?)(?:s)?\b/g)) {
    const name = mtc[1];
    if (name && name in DOW) set.add(DOW[name]!);
  }
  return [...set].sort((a, b) => a - b);
}

function extractMonths(text: string): number[] {
  const set = new Set<number>();
  for (const mtc of text.matchAll(/\b([a-z]+)\b/g)) {
    const name = mtc[1];
    if (name && name in MONTHS) set.add(MONTHS[name]!);
  }
  return [...set].sort((a, b) => a - b);
}

/** Day-of-month: "on the 1st", "on the 15th", "1st of the month". */
function extractDom(text: string): number | null {
  const m = text.match(/\b(?:on the|the)\s+(\d{1,2})(?:st|nd|rd|th)?\b/) ||
    text.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+(?:of|day)\b/);
  if (m && m[1]) {
    const d = Number(m[1]);
    if (d >= 1 && d <= 31) return d;
  }
  return null;
}

/**
 * Translate an English schedule description into a standard five-field cron
 * expression. Returns `{ error }` when nothing recognizable was found so the
 * caller can prompt the user to rephrase rather than saving a wrong schedule.
 */
export function nlToCron(input: string): NlCronResult {
  const text = ` ${input.toLowerCase().trim().replace(/\s+/g, " ")} `;
  if (!text.trim()) return { error: "Describe a schedule, e.g. “every day at 9am”." };

  // "Every N minutes/hours" (and the "every minute/hour", "hourly" shorthands)
  // are the frequency-driven forms — they set the minute/hour fields directly
  // and ignore any clock time. Everything else is time-of-day driven.
  const stepMatch = text.match(/\bevery\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\b/);
  const times = extractTimes(text);
  const dows = extractDows(text);
  const months = extractMonths(text);
  const dom = extractDom(text);

  const domField = dom != null ? String(dom) : "*";
  const monthField = months.length ? months.join(",") : "*";
  const dowField = dows.join(",") === "1,2,3,4,5" ? "1-5" : dows.length ? dows.join(",") : "*";

  if (stepMatch) {
    const n = Number(stepMatch[1]);
    const unit = stepMatch[2] ?? "";
    const isHour = /^h/.test(unit);
    if (n < 1) return { error: "Interval must be at least 1." };
    if (isHour) {
      if (n > 23) return { error: "Hour interval must be 23 or less. Use a daily time instead." };
      const minute = times.length ? String(times[0]!.m) : "0";
      const fields = { minute, hour: n === 1 ? "*" : `*/${n}`, dom: domField, month: monthField, dow: dowField };
      return ok(fields);
    }
    if (n > 59) return { error: "Minute interval must be 59 or less. Use an hourly interval instead." };
    const fields = { minute: n === 1 ? "*" : `*/${n}`, hour: "*", dom: domField, month: monthField, dow: dowField };
    return ok(fields);
  }

  if (/\bevery\s+minute\b/.test(text)) {
    return ok({ minute: "*", hour: "*", dom: domField, month: monthField, dow: dowField });
  }
  if (/\b(every\s+hour|hourly)\b/.test(text)) {
    const minute = times.length ? String(times[0]!.m) : "0";
    return ok({ minute, hour: "*", dom: domField, month: monthField, dow: dowField });
  }

  // Time-of-day driven. Multiple times collapse into comma-lists, but only when
  // they share a minute (cron can't express "9:00 and 17:30" in one line).
  let minuteField: string;
  let hourField: string;
  if (times.length === 0) {
    // A day-only phrase ("every monday", "weekdays", "on the 1st") defaults to
    // midnight so it's a valid, unambiguous once-a-day schedule.
    if (dows.length === 0 && dom == null && months.length === 0) {
      return { error: "Add a time, e.g. “every day at 9am” or “every 15 minutes”." };
    }
    minuteField = "0";
    hourField = "0";
  } else if (times.length === 1) {
    minuteField = String(times[0]!.m);
    hourField = String(times[0]!.h);
  } else {
    const minutes = new Set(times.map((t) => t.m));
    if (minutes.size > 1) {
      return { error: "Multiple times must share the same minute (e.g. “at 9am and 5pm”)." };
    }
    minuteField = String(times[0]!.m);
    hourField = times.map((t) => t.h).join(",");
  }

  return ok({ minute: minuteField, hour: hourField, dom: domField, month: monthField, dow: dowField });
}

function ok(fields: NlCronOk["fields"]): NlCronOk {
  return { cron: `${fields.minute} ${fields.hour} ${fields.dom} ${fields.month} ${fields.dow}`, fields };
}

export function isNlCronOk(r: NlCronResult): r is NlCronOk {
  return (r as NlCronOk).cron !== undefined;
}
