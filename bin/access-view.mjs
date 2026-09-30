// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Terminal views of the node's access report (src/access.ts): the full
// `bivy access` screen and the one-line summary `bivy status` shows.

const REACH_WORD = ["", "on your tailnet", "from anywhere"];

/** "Tailscale + Bivy hosted", or "This machine only". */
export function activeLabel(report) {
  const on = report.setups.filter((s) => s.active && s.id !== "local");
  return on.length ? on.map((s) => s.label).join(" + ") : "This machine only";
}

function labelOf(report, id) {
  return report.setups.find((s) => s.id === id)?.label ?? id;
}

/** `access: Tailscale — next: Bivy hosted` for `bivy status`. */
export function accessLine(report) {
  const next = report.next.filter((n) => n.id !== "server").map((n) => labelOf(report, n.id));
  return `${activeLabel(report)}${next.length ? ` — next: ${next.join(" or ")} ('bivy access')` : ""}`;
}

/** The `bivy access` screen as lines; `paint` supplies colors. */
export function accessScreen(report, paint) {
  const lines = [`${paint.bold("Access:")} ${activeLabel(report)}`];
  if (report.tailscaleUrl) lines.push(`  ${paint.dim("tailnet")}  ${report.tailscaleUrl}`);
  if (report.controlPlaneUrl) lines.push(`  ${paint.dim("app")}      ${report.controlPlaneUrl}`);
  lines.push("");
  for (const feature of report.features) {
    const reach = report.reach[feature.id];
    lines.push(`  ${reach ? paint.green("✓") : paint.dim("✗")} ${feature.label}${reach ? paint.dim(` ${REACH_WORD[reach]}`.trimEnd()) : ""}`);
  }
  if (report.next.length) {
    lines.push("", paint.bold("Next:"));
    for (const step of report.next) {
      const setup = report.setups.find((s) => s.id === step.id);
      lines.push(`  ${paint.cyan((setup?.command ?? "").padEnd(26))} ${setup?.label}`, `  ${" ".repeat(26)} ${paint.dim(`adds ${step.addsText}`)}`);
    }
  }
  lines.push("", paint.dim("Setups stack: adding one never takes away another. 'bivy access local' turns remote access off."));
  return lines;
}
