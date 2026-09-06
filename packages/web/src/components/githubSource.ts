// SPDX-License-Identifier: AGPL-3.0-only
import type { GithubAppInfo, CentralGithubAppInstallationView } from "@bivy/core";

/** Source connection is separate from availability of an automation executor. */
export function githubSourceStatus(gh: GithubAppInfo | null): { tone: "on" | "off" | "warn"; label: string; detail: string } {
  if (!gh) return { tone: "warn", label: "Status unavailable", detail: "Refresh to check the GitHub App connection." };
  if (!gh.connected || !gh.apps.length) return { tone: "off", label: "Not connected", detail: "Install the hosted Bivy App or connect a custom GitHub App." };
  const installed = gh.apps.filter((app) => app.installed || (app.installCount ?? 0) > 0);
  if (!installed.length) return { tone: "warn", label: "App connected · installation needed", detail: "Install the app on repositories, or refresh if installation status has not synced." };
  const hosted = installed.some((app) => app.central);
  const custom = installed.some((app) => !app.central);
  return {
    tone: "on",
    label: hosted && custom ? "Hosted + custom apps connected" : hosted ? "Hosted Bivy App connected" : "Custom GitHub App connected",
    detail: "Repository access is connected. Automations separately need an available executor.",
  };
}

export function githubMentionHandles(gh: GithubAppInfo | null, appId = ""): string[] {
  return [...new Set((gh?.apps ?? [])
    .filter((app) => !appId || app.appId === appId)
    .map((app) => app.mention?.replace(/^@/, ""))
    .filter((mention): mention is string => Boolean(mention)))];
}

export function githubInstallationSettings(installation: CentralGithubAppInstallationView): string {
  const id = encodeURIComponent(installation.installationId);
  return installation.githubAccountType === "Organization" && installation.githubAccount
    ? `https://github.com/organizations/${encodeURIComponent(installation.githubAccount)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}
