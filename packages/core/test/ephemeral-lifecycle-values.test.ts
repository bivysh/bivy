// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  clampTtlMinutes,
} from "../src/ephemeral-lifecycle.js";

describe("pure ephemeral lifecycle values", () => {
  it("normalizes TTL as a pure value transformation", () => {
    expect(clampTtlMinutes()).toBe(60);
    expect(clampTtlMinutes(1)).toBe(5);
    expect(clampTtlMinutes(10_000)).toBe(1_440);
  });
});
