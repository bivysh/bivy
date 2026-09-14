import { test as base, expect } from "@playwright/test";

export * from "@playwright/test";

// These are UI tests, not live-backend tests. Page-level routes in individual
// specs take precedence over this context-level safety net, including deliberate
// error responses. Never let an omitted mock reach the developer's local daemon.
export const test = base.extend<{ apiIsolation: void }>({
  apiIsolation: [async ({ context }, use) => {
    const unexpected: string[] = [];
    await context.route(url => url.pathname === "/api" || url.pathname.startsWith("/api/"), async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/push/preferences") {
        await route.fulfill({ json: { preferences: {
          question_asked: true,
          approval_requested: true,
          agent_waiting: true,
          session_done: true,
          session_error: true,
          terminal_bell: true,
        } } });
        return;
      }
      unexpected.push(`${request.method()} ${request.url()}`);
      await route.fulfill({ status: 501, json: { error: "Missing browser-test API mock" } });
    });
    await use();
    expect(unexpected, "Unexpected API requests: add explicit mocks (including intentional failures)").toEqual([]);
  }, { auto: true }],
});
