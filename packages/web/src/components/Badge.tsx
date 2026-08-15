// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { HTMLAttributes, ReactNode } from "react";

export type BadgeTone = "accent" | "ok" | "warn" | "danger" | "merged" | "unseen";
export type BadgeVariant = "outline" | "soft" | "solid";

/** Canonical compact label: tone controls meaning; variant controls emphasis. */
export function Badge({
  tone,
  variant = "outline",
  upper = false,
  className = "",
  children,
  ...props
}: {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  upper?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "children">) {
  return (
    <span
      className={`badge${upper ? " upper" : ""}${className ? ` ${className}` : ""}`}
      data-tone={tone}
      data-variant={variant}
      {...props}
    >
      {children}
    </span>
  );
}
