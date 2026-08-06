import assert from "node:assert/strict";
import { buildChangeSetReviewPrompt, buildFileReviewPrompt, type ReviewPromptFile } from "../packages/web/src/changeReviewPrompt.js";

const file: ReviewPromptFile = { path: "src/auth.ts", status: "modified", added: 8, removed: 3 };
const single = buildFileReviewPrompt(file);
assert.match(single, /`src\/auth\.ts` \(modified, \+8\/−3\)/);
assert.match(single, /security risks/);

const files = Array.from({ length: 32 }, (_, index): ReviewPromptFile => ({
  path: `src/file-${index}.ts`,
  status: "modified",
  added: index,
  removed: 0,
}));
const set = buildChangeSetReviewPrompt(files, [
  { name: "typecheck", status: "passed" },
  { name: "unit tests", status: "failed" },
]);
assert.match(set, /`src\/file-0\.ts`/);
assert.match(set, /and 2 more changed files/);
assert.doesNotMatch(set, /file-30/);
assert.match(set, /Failed checks to investigate: unit tests/);
assert.doesNotMatch(set, /Failed checks to investigate: typecheck/);

console.log("change-review-prompt: all tests passed");
