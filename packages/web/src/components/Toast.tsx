// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { HTMLAttributes, ReactNode } from "react";

export type ToastTone = "ok" | "danger" | "accent";

/** Canonical transient feedback shell. Feature components provide content and dismissal behavior. */
export function Toast({
  tone,
  className = "",
  children,
  ...props
}: {
  tone: ToastTone;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return <div className={`toast${className ? ` ${className}` : ""}`} data-tone={tone} {...props}>{children}</div>;
}

export function StatusIcon({ tone, children }: { tone: "ok" | "danger"; children: ReactNode }) {
  return <span className="status-icon" data-tone={tone} aria-hidden>{children}</span>;
}
