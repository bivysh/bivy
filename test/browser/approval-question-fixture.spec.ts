// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../", import.meta.url);

test("injected approval and question cards stay reachable and semantic", async ({ page }, testInfo) => {
  const [tokens, styles] = await Promise.all([
    readFile(new URL("packages/ui/tokens.css", ROOT), "utf8"),
    readFile(new URL("packages/web/src/styles.css", ROOT), "utf8"),
  ]);
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
    <main style="max-width:720px;margin:var(--space-4) auto">
      <div class="attention-footer" aria-live="polite" aria-label="Agent needs your response">
        <div class="card approval-card" data-tone="danger" data-attention-card tabindex="-1" data-frame="approval.request">
          <div class="approval-head"><strong>Run a command?</strong><span class="badge" data-tone="danger">High risk</span></div>
          <p>Writes outside the workspace.</p>
          <pre class="approval-command">echo hi &gt; /tmp/notes.md</pre>
          <div class="approval-actions"><button class="btn danger-ghost">Reject</button><button class="btn primary">Approve once</button></div>
        </div>
        <div class="card question-card" data-tone="accent" data-attention-card tabindex="-1" data-frame="question.request">
          <strong>Which approach?</strong>
          <div class="question-options"><button class="question-option">Smallest change</button><button class="question-option">Refactor</button></div>
        </div>
      </div>
    </main>
  </body></html>`);
  await page.addStyleTag({ content: `${tokens}\n${styles}` });

  const cards = page.locator("[data-attention-card]");
  await expect(cards).toHaveCount(2);
  await cards.first().focus();
  await expect(cards.first()).toBeFocused();
  await expect(page.locator('[aria-live="polite"]')).toHaveAttribute("aria-label", "Agent needs your response");
  for (const box of await cards.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.screenshot({ path: testInfo.outputPath("approval-question-cards.png"), fullPage: true });
});
