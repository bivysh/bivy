// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { githubSourceStatus, githubMentionHandles, githubInstallationSettings } from "../../packages/web/src/components/githubSource.js";

// Pure status/link formatting does not need Chromium or a Vite server.
test("connection status does not conflate hosted installation with executor readiness", () => {
  const installation = { installationId: "42", githubAccount: "acme", githubAccountType: "Organization", createdAt: "2026-09-01" };
  const hosted = { connected: true, appId: "123", central: true, hosted: true, installed: true, mention: "bivy-hosted", name: "Hosted Bivy App", servedBy: null, installations: [installation] };
  const custom = { connected: true, appId: "456", installed: true, mention: "acme-bot", name: "Acme custom app", servedBy: null };
  expect(githubSourceStatus({ connected: true, apps: [hosted] })).toMatchObject({ tone: "on", label: "Hosted Bivy App connected" });
  expect(githubSourceStatus({ connected: true, apps: [custom] }).label).toBe("Custom GitHub App connected");
  expect(githubSourceStatus({ connected: true, apps: [hosted, custom] }).label).toBe("Hosted + custom apps connected");
  expect(githubSourceStatus(null).label).toBe("Status unavailable");
  expect(githubSourceStatus({ connected: false, apps: [] }).tone).toBe("off");
  expect(githubMentionHandles({ connected: true, apps: [hosted, custom] })).toEqual(["bivy-hosted", "acme-bot"]);
  expect(githubMentionHandles({ connected: true, apps: [hosted, custom] }, "456")).toEqual(["acme-bot"]);
  expect(githubMentionHandles(null)).toEqual([]);
  expect(githubInstallationSettings(installation)).toBe("https://github.com/organizations/acme/settings/installations/42");
  expect(githubInstallationSettings({ ...installation, githubAccountType: "User" })).toBe("https://github.com/settings/installations/42");
});
