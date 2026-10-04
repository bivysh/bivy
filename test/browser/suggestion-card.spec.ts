// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => { url = webApp.origin; });

const suggestions = [
  { id: "suggestion-a", title: "Live status page", text: "Build a small status page for the relay's /metrics and publish it as a live preview I can open on my phone.\n\nShow connection counts, uptime and recent errors.\n\nKeep the page readable on narrow screens and support both light and dark themes.\n\nInclude a refresh button and explain when the relay is unavailable.\n\nPublish the finished page so I can review it." },
  { id: "suggestion-b", title: "Add /version", text: "Add a /version endpoint that returns the package version, git commit and uptime.", run: "subagents" },
  { id: "suggestion-c", text: "Document the metrics in the README." },
];

for (const theme of themes) test(`suggested tasks are picked, then started in new sessions or here (${theme})`, async ({ page }, testInfo) => {
  await page.routeWebSocket(/.*/, () => {});
  for (const endpoint of ["auth/bootstrap", "sessions", "session/presence/get", "session/history", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "Daemon offline in suggestion fixture" } }));
  }
  await page.addInitScript((value) => localStorage.setItem("bivy_theme", value), theme);
  await page.goto(url);
  await page.evaluate(async (items) => {
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    const w = window as any;
    w.c = c; w.sent = []; w.prompts = []; let n = 0;
    c.transport.close();
    c.transport.send = async () => {};
    c.sendToCurrentNode = (command: Record<string, unknown>) => {
      w.sent.push(command);
      if (command.kind === "session.new") setTimeout(() => c.sessionCoordinator.handleEvent({ type: "session.history", requestId: command.requestId, sessionId: `new-${++n}`, messages: [] }), 30);
    };
    c.sendPrompt = (text: string) => { w.prompts.push(text); };
    c.store.setStatus("online");
    c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Relay tour", runtimeId: "claude", status: "saved" }] });
    c.openSession("s");
    c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "claude", messages: [
      { role: "user", content: "I'm new to Bivy. Show me around." },
      { role: "assistant", content: "This is bivy-relay, a small TypeScript service that relays encrypted frames between clients and nodes. Three first tasks:" },
    ] });
    for (const suggestion of items) c.store.apply({ type: "session.event", sessionId: "s", event: { type: "suggestion", id: suggestion.id, suggestion } });
    c.store.apply({ type: "session.event", sessionId: "s", event: { type: "message_end", message: { role: "assistant", content: "Choose a task below to get started." } } });
    c.store.apply({ type: "session.event", sessionId: "s", event: { type: "agent_end" } });
  }, suggestions);

  const card = (name: string) => page.getByRole("region", { name: `Suggested task: ${name}` });
  const last = card("Document the metrics in the README.");
  await expect(card("Live status page")).toContainText("publish it as a live preview");
  const answer = page.getByText("Choose a task below to get started.", { exact: true });
  for (const focus of [false, true]) {
    if (focus) await page.getByRole("button", { name: "Show only prompts and final answers" }).click();
    await expect(answer).toBeVisible();
    expect(await answer.evaluate((el) => !!(el.compareDocumentPosition(document.querySelector(".suggestion-card")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  }
  await page.getByRole("button", { name: "Show full transcript" }).click();
  const statusCard = card("Live status page");
  const description = statusCard.locator(".suggestion-text");
  const more = statusCard.getByRole("button", { name: "Show more", exact: true });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toHaveAttribute("aria-controls", await description.getAttribute("id") as string);
  expect(await description.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(card("Add /version").getByRole("button", { name: "Show more" })).toHaveCount(0);
  await more.focus();
  await more.press("Enter");
  const less = statusCard.getByRole("button", { name: "Show less", exact: true });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await expect(less).toBeFocused();
  expect(await description.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  await expect(description).toHaveText(suggestions[0].text);
  await less.evaluate((el) => el.blur());
  await statusCard.screenshot({ path: testInfo.outputPath(`suggestion-expanded-${theme}.png`) });
  await less.focus();
  await less.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  expect(await description.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await more.evaluate((el) => el.blur());
  await statusCard.screenshot({ path: testInfo.outputPath(`suggestion-collapsed-${theme}.png`) });
  await page.getByRole("checkbox", { name: "Live status page" }).focus();
  await expect(page.getByRole("checkbox", { name: "Live status page" })).toBeFocused();
  // In a run, each card is a checkbox (all selected) and the run's last card holds the one action bar.
  // Mixed recommendations fall back to new sessions; sub-agents show because one card offered them.
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(3);
  await expect(page.getByRole("button", { name: /new session/ })).toHaveCount(1);
  await expect(last.locator(".btn.primary")).toHaveText("Start 3 new sessions");
  await expect(last.getByRole("button", { name: "Run 3 as sub-agents" })).toBeVisible();
  await answer.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath(`suggestions-${theme}.png`), fullPage: true });

  await page.getByRole("checkbox", { name: "Add /version" }).uncheck();
  await expect(last).toContainText("2 of 3 selected");
  await last.getByRole("button", { name: "Start 2 new sessions" }).click();
  await expect(card("Live status page")).toContainText("Started in a new session");
  await expect(last).toContainText("Started in a new session");
  expect(await page.evaluate(() => (window as any).sent.filter((c: any) => c.kind === "session.new").map((c: any) => [c.like, c.prompt]))).toEqual([["s", suggestions[0].text], ["s", suggestions[2].text]]);

  // The unticked one stays open, and alone its own recommendation leads.
  await page.getByRole("checkbox", { name: "Add /version" }).check();
  await expect(last.locator(".btn.primary")).toHaveText("Use a sub-agent");
  await last.getByRole("button", { name: "Use a sub-agent" }).click();
  await expect(card("Add /version")).toContainText("Sent to this session’s sub-agents");
  expect(await page.evaluate(() => (window as any).prompts)).toEqual([`Please hand this task to a sub-agent, then report back:\n\n${suggestions[1].text}`]);
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  // Remembered per device, so a reload shows it as started rather than offering it again.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("bivy:suggestion:suggestion-a") ?? "null"))).toEqual({ where: "new", sessionId: "new-1" });
});
