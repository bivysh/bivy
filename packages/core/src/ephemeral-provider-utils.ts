// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Formatting utilities shared by the boot payload builders.

export const utf8 = new TextEncoder();

export function shq(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
