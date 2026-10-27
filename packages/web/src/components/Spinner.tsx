// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

export type SpinnerSize = "xs" | "sm" | "md" | "lg";

/** Canonical indeterminate loading indicator. The surrounding control or
 * status region owns the accessible loading label. */
export function Spinner({
  size = "md",
  tone = "accent",
}: {
  size?: SpinnerSize;
  tone?: "accent" | "inverse";
}) {
  return <span className="spinner" data-size={size} data-tone={tone} aria-hidden />;
}
