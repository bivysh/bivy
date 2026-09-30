// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => {
  url = webApp.origin;
});

const SEED = [
  "I am continuing an existing Bivy session (forked from claude to Codex).",
  "Session: Source conversation",
  "Full earlier conversation, as a local file (read it with your file tools): /data/fork-transcripts/a.md",
].join("\n");

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/.*/, () => {});
  for (const endpoint of ["auth/bootstrap", "sessions", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), route => route.fulfill({
      status: 503, json: { error: "Daemon intentionally offline in fork hand-off fixture" },
    }));
  }
  await page.goto(url);
  await page.evaluate(async () => {
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    (window as any).c = c;
    (window as any).sent = [];
    // Deliver node replies the way a live transport does, through the controller.
    (window as any).handlers = c.buildTransportHandlers();
    c.transport.close();
    c.transport.send = async (command: unknown) => { (window as any).sent.push(command); };
    c.store.setError("");
    c.store.setStatus("online");
    c.store.apply({ type: "runtimes.list", runtimes: [
      { id: "claude", name: "Claude", status: "available" },
      { id: "codex", name: "Codex", status: "available" },
      { id: "aider", name: "Aider", status: "missing" },
    ] });
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "source", name: "Source conversation", runtimeId: "claude", status: "saved" }] });
    c.openSession("source");
  });
});

test("a hand-off seed reads as one line that opens the text that was sent", async ({ page }) => {
  await page.evaluate((seed) => (window as any).c.store.apply({ type: "session.history", sessionId: "source", runtimeId: "claude", messages: [
    { role: "user", content: "Original ask" },
    { role: "assistant", content: "Original answer" },
    { role: "user", content: seed },
  ] }), SEED);
  await expect(page.getByText("Original answer")).toBeVisible();
  await expect(page.getByText("I am continuing an existing Bivy session")).toHaveCount(0);
  const line = page.getByRole("button", { name: /Handed over: Conversation context from Claude/ });
  await line.click();
  const sheet = page.getByRole("dialog", { name: "Context sent to the agent" });
  await expect(sheet).toContainText("/data/fork-transcripts/a.md");
});

test("a cross-agent fork offers the target agent's models and only agents that can run here", async ({ page }) => {
  await page.evaluate(() => (window as any).c.store.apply({ type: "session.history", sessionId: "source", runtimeId: "claude", messages: [{ role: "user", content: "Original ask" }] }));
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: /Fork/ }).click();
  const agents = page.locator("#fork-agent option");
  await expect(agents).toHaveText(["Claude (current)", "Codex"]);
  await page.selectOption("#fork-agent", "codex");
  await expect.poll(() => page.evaluate(() => (window as any).sent.some((m: any) => m.kind === "models.list" && m.runtimeId === "codex"))).toBe(true);
  await page.evaluate(() => (window as any).handlers.onEvent({ type: "models.list", runtimeId: "codex", sessionId: "scratch", current: { provider: "openai", id: "gpt-a" }, models: [
    { provider: "openai", id: "gpt-a", name: "GPT A" },
    { provider: "openai", id: "gpt-b", name: "GPT B" },
  ] }));
  await expect(page.locator("#fork-target-model option")).toHaveText(["The agent’s default model", "GPT A · openai", "GPT B · openai"]);
  // The composer keeps the source agent's view; the target list only fed the sheet.
  expect(await page.evaluate(() => (window as any).c.store.getState().catalogs.modelsRuntimeId)).not.toBe("codex");
});
