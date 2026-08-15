// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const STYLES = new URL("../../packages/web/src/styles.css", import.meta.url);
const APP = new URL("../../packages/web/src/App.tsx", import.meta.url);
const COMPOSER = new URL("../../packages/web/src/components/Composer.tsx", import.meta.url);
const SHEET = new URL("../../packages/web/src/components/ScheduleSheet.tsx", import.meta.url);
const QUEUE = new URL("../../packages/web/src/components/FollowupQueue.tsx", import.meta.url);

test("the composer uses one normal Send control without Run or Schedule alternatives", async () => {
  const source = await readFile(COMPOSER, "utf8");
  expect(source).toContain('type="submit"\n                className="composer-btn send"');
  expect(source).not.toContain('className="split-send"');
  expect(source).not.toContain('aria-label="More send options"');
  expect(source).not.toContain("Start a Run");
  expect(source).not.toContain("Schedule for later");
});

test("obsolete split Send styles are removed", async () => {
  const css = await readFile(STYLES, "utf8");
  expect(css).not.toContain(".split-send {");
  expect(css).not.toContain(".split-send-toggle {");
  expect(css).not.toContain(".send-options-menu {");
});

test("slash commands remain available inline without a composer button", async () => {
  const [app, composer] = await Promise.all([
    readFile(APP, "utf8"),
    readFile(COMPOSER, "utf8"),
  ]);
  expect(app).not.toContain('className="slash-pill"');
  expect(composer).toContain("matchSlashCommands(text, agentCommands)");
  expect(composer).toContain("if (isSlashInput(value))");
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

test("every focused text entry inherits the canonical 16px field shell so iOS never auto-zooms", async () => {
  const [css, queue, schedule, question] = await Promise.all([
    readFile(STYLES, "utf8"),
    readFile(QUEUE, "utf8"),
    readFile(SHEET, "utf8"),
    readFile(new URL("../../packages/web/src/components/QuestionCard.tsx", import.meta.url), "utf8"),
  ]);
  expect(ruleFor(css, ".field, .picker-search")).toContain("font-size: 16px");
  expect(queue).toContain('className="field followup-edit-input"');
  expect(schedule).toContain('className="field"');
  expect(question).toContain('className="field question-other-input"');
});

test("ScheduleSheet infers the target from the screen instead of asking", async () => {
  const source = await readFile(SHEET, "utf8");
  // Target is derived from the open session / draft — there is no "this or new
  // session" question.
  expect(source).toContain("const target: \"existing_session\" | \"new_session\" = active ? \"existing_session\" : \"new_session\";");
  expect(source).toContain("<Sheet title=\"Schedule message\" onClose={onClose} autoFocusSearch={false}>");
  // The node for delivery comes from the session, falling back to the draft's.
  expect(source).toContain("const nodeId = active?.nodeId ?? state.connection.currentNodeId;");
});

test("queue rows show scheduled messages with a reschedule action, delivered by the automation", async () => {
  const source = await readFile(QUEUE, "utf8");
  expect(source).toContain("Sends today at");
  expect(source).toContain("aria-label=\"Change scheduled time\"");
  expect(source).toContain("controller.editScheduledFollowup(sessionId, item.id, when)");
  expect(source).toContain("aria-label=\"Cancel scheduled message\"");
});
