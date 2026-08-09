// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const STYLES = new URL("../../packages/web/src/styles.css", import.meta.url);
const COMPOSER = new URL("../../packages/web/src/components/Composer.tsx", import.meta.url);
const SHEET = new URL("../../packages/web/src/components/ScheduleSheet.tsx", import.meta.url);
const QUEUE = new URL("../../packages/web/src/components/FollowupQueue.tsx", import.meta.url);

test("long-press Send: touch-aware hold that suppresses the release click", async () => {
  const source = await readFile(COMPOSER, "utf8");
  // The schedule sheet is opened from a hold, so the release must never submit.
  expect(source).toContain("window.addEventListener(\"click\", swallow, true)");
  expect(source).toContain("onContextMenu={(e) => e.preventDefault()}");
  // iOS long-presses preempt the pointer stream with text-selection/callout, so
  // the hold must also be armed from touch events, not only pointer events.
  expect(source).toContain("onPointerDown={(e) => {");
  expect(source).toContain("onTouchStart={() => {");
  expect(source).toContain("onTouchMove={cancelLongPress}");
  expect(source).toContain("onTouchEnd={cancelLongPress}");
  expect(source).toContain("onPointerCancel={cancelLongPress}");
});

test("send-button callout suppression so a hold doesn't select text or pop the menu", async () => {
  const css = await readFile(STYLES, "utf8");
  // Everything from the first .composer-btn.send rule through .composer-btn.stop
  // (the send button owns both declarations; .stop separates the two blocks).
  const block = css.slice(css.indexOf(".composer-btn.send"), css.indexOf(".composer-btn.stop"));
  expect(block).toContain("-webkit-touch-callout: none;");
  expect(block).toContain("-webkit-user-select: none;");
  expect(block).toContain("user-select: none;");
  expect(block).toContain("touch-action: manipulation;");
});

/** The declaration block of the exact CSS rule `selector { … }` — anchored at
 *  line start so a comment above the rule, or a compound selector that merely
 *  ends in it (e.g. `.ruleset-chain-field .picker-search`), can't hijack it. */
function ruleFor(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`rule not found: ${selector}`);
  const declStart = css.indexOf("{", start) + 1;
  return css.slice(declStart, css.indexOf("}", declStart));
}

test("every focused text entry stays at 16px so iOS Safari never auto-zooms", async () => {
  const css = await readFile(STYLES, "utf8");
  // The queue editor, the schedule datetime field, the "Other" agent input, and
  // the search fields are all focused directly on mobile; anything below 16px
  // makes iOS zoom the viewport on focus (see the file-top comment).
  for (const selector of [
    ".followup-edit-input",
    ".schedule-input",
    ".question-other-input",
    ".picker-search",
    ".settings-search",
  ]) {
    expect(ruleFor(css, selector), `${selector} must be 16px`).toContain("font-size: 16px");
  }
});

test("ScheduleSheet infers the target from the screen instead of asking", async () => {
  const source = await readFile(SHEET, "utf8");
  // Target is derived from the open session / draft — there is no "this or new
  // session" question.
  expect(source).toContain("const target: \"existing_session\" | \"new_session\" = active ? \"existing_session\" : \"new_session\";");
  expect(source).toContain("<Sheet title=\"Schedule message\" onClose={onClose} autoFocusSearch={false}>");
  // The node for delivery comes from the session, falling back to the draft's.
  expect(source).toContain("const nodeId = active?.nodeId ?? state.currentNodeId;");
});

test("queue rows show scheduled messages with a reschedule action, delivered by the automation", async () => {
  const source = await readFile(QUEUE, "utf8");
  expect(source).toContain("Sends today at");
  expect(source).toContain("aria-label=\"Change scheduled time\"");
  expect(source).toContain("controller.editScheduledFollowup(sessionId, item.id, when)");
  expect(source).toContain("aria-label=\"Cancel scheduled message\"");
});
