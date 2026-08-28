// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** A Linear issue fetched just-in-time by the node that claimed the work. */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
}

/** Fetch issue content without sending the Linear API key or description to the control plane. */
export async function getLinearIssue(apiKey: string, id: string, fetchImpl: typeof fetch = fetch): Promise<LinearIssue | undefined> {
  if (!apiKey.trim() || !id.trim()) return undefined;
  const res = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      query: "query BivyLinearIssue($id: String!) { issue(id: $id) { id identifier title description url } }",
      variables: { id },
    }),
  });
  if (!res.ok) return undefined;
  const raw = (await res.json().catch(() => undefined)) as { data?: { issue?: Record<string, unknown> }; errors?: unknown[] } | undefined;
  const issue = raw?.data?.issue;
  if (!issue || raw?.errors?.length) return undefined;
  const identifier = String(issue.identifier ?? "").trim();
  const title = String(issue.title ?? "").trim();
  if (!identifier || !title) return undefined;
  return {
    id: String(issue.id ?? id),
    identifier,
    title,
    description: String(issue.description ?? ""),
    url: String(issue.url ?? ""),
  };
}

export function linearBranchName(identifier: string): string {
  const slug = identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `bivy/linear-${slug || "issue"}`;
}

export function buildLinearTaskPrompt(issue: LinearIssue, instructions?: string): string {
  return [
    `You are working on Linear issue ${issue.identifier}: ${issue.title}`,
    "",
    issue.description.trim() || "(no description provided)",
    "",
    issue.url ? `Issue: ${issue.url}` : "",
    "",
    instructions?.trim() || "Understand the issue and surrounding codebase, implement it completely, and run the project's tests, linter, and type-checker.",
    "",
    instructions?.trim() ? "" : `When finished, commit and push your changes and open a pull request yourself. Include a link to ${issue.identifier} in the pull request description.`,
  ].filter((part, index, all) => part !== "" || all[index - 1] !== "").join("\n");
}
