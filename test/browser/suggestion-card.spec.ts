// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => { url = webApp.origin; });

const suggestions = [
  { id: "suggestion-a", title: "Live status page", text: "Build a small status page for the relay's /metrics and publish it as a live preview I can open on my phone." },
  { id: "suggestion-b", title: "Add /version", text: "Add a /version endpoint that returns the package version, git commit and uptime." },
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
  }, suggestions);

  const card = (name: string) => page.getByRole("region", { name: `Suggested task: ${name}` });
  const last = card("Document the metrics in the README.");
  await expect(card("Live status page")).toContainText("publish it as a live preview");
  // In a run, each card is a checkbox (all selected) and the run's last card holds the one action bar.
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(3);
  await expect(page.getByRole("button", { name: /new session/ })).toHaveCount(1);
  await expect(last.getByRole("button", { name: "Start 3 new sessions" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`suggestions-${theme}.png`), fullPage: true });

  await page.getByRole("checkbox", { name: "Add /version" }).uncheck();
  await expect(last).toContainText("2 of 3 selected");
  await last.getByRole("button", { name: "Start 2 new sessions" }).click();
  await expect(card("Live status page")).toContainText("Started in a new session");
  await expect(last).toContainText("Started in a new session");
  expect(await page.evaluate(() => (window as any).sent.filter((c: any) => c.kind === "session.new").map((c: any) => [c.like, c.prompt]))).toEqual([["s", suggestions[0].text], ["s", suggestions[2].text]]);

  // The unticked one stays open; selecting it and choosing "here" sends it to this session.
  await page.getByRole("checkbox", { name: "Add /version" }).check();
  await last.getByRole("button", { name: "Do it here" }).click();
  await expect(card("Add /version")).toContainText("✓ Sent to this session");
  expect(await page.evaluate(() => (window as any).prompts)).toEqual([suggestions[1].text]);
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  // Remembered per device, so a reload shows it as started rather than offering it again.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("bivy:suggestion:suggestion-a") ?? "null"))).toEqual({ where: "new", sessionId: "new-1" });
});
