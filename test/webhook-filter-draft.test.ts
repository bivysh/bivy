// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import test from "node:test";
import { decodeAutomationTemplate, encodeAutomationTemplate } from "../packages/core/src/automation-template.js";
import { buildWebhookFilter, filterDraftFrom, formatArgv, parseArgv } from "../packages/web/src/components/webhookFilterDraft.js";

test("argv parsing honours quotes without shell expansion", () => {
  assert.deepEqual(parseArgv("node  filter.mjs"), ["node", "filter.mjs"]);
  assert.deepEqual(parseArgv(`python3 "my filter.py" '$HOME' ""`), ["python3", "my filter.py", "$HOME", ""]);
  assert.equal(parseArgv(`node "unclosed`), null);
});

test("argv formatting round-trips through the parser", () => {
  for (const argv of [["node", "filter.mjs"], ["/usr/bin/env", "a b", ""], [`it's`, `say "hi"`, `mix'"ed`]]) {
    assert.deepEqual(parseArgv(formatArgv(argv)), argv);
  }
});

test("a filter survives load and save through the encrypted template", () => {
  const filter = { command: ["node", "basecamp filter.mjs"], cwd: "/srv/bivy/trusted-filters", timeoutSeconds: 10 };
  const loaded = filterDraftFrom(decodeAutomationTemplate(encodeAutomationTemplate("Do it", {}, filter)).filter);
  assert.equal(loaded.enabled, true);
  assert.deepEqual(buildWebhookFilter(loaded), { filter });
});

test("disabled drafts save no filter; invalid enabled drafts are rejected", () => {
  assert.deepEqual(buildWebhookFilter(filterDraftFrom()), {});
  const base = { enabled: true, command: "node f.mjs", cwd: "/srv/f", timeoutSeconds: "5" };
  assert.ok(buildWebhookFilter({ ...base, command: "  " }).error);
  assert.ok(buildWebhookFilter({ ...base, cwd: "relative/dir" }).error);
  assert.ok(buildWebhookFilter({ ...base, timeoutSeconds: "61" }).error);
  assert.ok(buildWebhookFilter({ ...base, timeoutSeconds: "1.5" }).error);
  assert.deepEqual(buildWebhookFilter({ ...base, timeoutSeconds: "" }).filter?.timeoutSeconds, 5);
});
