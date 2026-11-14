// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { describe, it, expect } from "vitest";
import { parseKeyLines } from "../src/key-lines.js";

describe("parseKeyLines", () => {
  it("reads a pasted .env / shell export block", () => {
    const text = [
      "# Stripe",
      "export STRIPE_API_KEY=sk_test_1=2",
      "OPENAI_KEY=\"sk proj # not a comment\"",
      "  TOKEN = 'abc'  ",
      "PLAIN=value # trailing comment",
      "",
      "github.token=nope",
      "EMPTY=",
      "not an assignment",
      "TOKEN=later",
    ].join("\r\n");
    expect(parseKeyLines(text)).toEqual({
      keys: [
        { name: "STRIPE_API_KEY", value: "sk_test_1=2" },
        { name: "OPENAI_KEY", value: "sk proj # not a comment" },
        { name: "PLAIN", value: "value" },
        { name: "TOKEN", value: "later" },
      ],
      skipped: [7, 8, 9],
    });
  });
});
