// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// What read-aloud actually says. Markup an agent writes to PLACE something must
// not be read out as punctuation: a reader hearing "colon colon view open brace
// s r c equals" has been handed the implementation instead of the message.
import { strict as assert } from "node:assert";
import test from "node:test";

import { markdownToSpeech } from "../packages/web/src/speech.js";

test("speaks a component directive's caption, not the directive", () => {
  const spoken = markdownToSpeech(
    ['Here is the report.', '', '::view{src=out/report.pdf caption="The quarterly summary"}', '', 'Done.'].join("\n"),
  );
  assert.ok(!spoken.includes("::view"), `directive leaked into speech: ${spoken}`);
  assert.ok(!spoken.includes("out/report.pdf"), `path leaked into speech: ${spoken}`);
  assert.ok(spoken.includes("The quarterly summary"), "the caption is the speakable part");
  assert.ok(spoken.startsWith("Here is the report."));
  assert.ok(spoken.endsWith("Done."));
});

test("says nothing for a directive with no caption, rather than reading its path", () => {
  const spoken = markdownToSpeech(["Before.", "::view{src=data/use.csv}", "After."].join("\n"));
  assert.equal(spoken, "Before.\nAfter.");
});

test("leaves a line that merely looks like a directive as prose", () => {
  // Block-level by construction, so this is a sentence, not markup.
  const spoken = markdownToSpeech("I ran ::view{src=a.csv} by hand.");
  assert.ok(spoken.includes("::view{src=a.csv}"), spoken);
});

test("still drops a bivy spec with the other fenced code, and reads an image's caption", () => {
  const spoken = markdownToSpeech(
    ["Totals:", "", "```bivy", '{"type":"metric","value":42}', "```", "", "![A chart of use](out/chart.png)"].join("\n"),
  );
  assert.ok(!spoken.includes("metric"), `spec leaked into speech: ${spoken}`);
  assert.ok(spoken.includes("A chart of use"));
  assert.ok(!spoken.includes("out/chart.png"));
});
