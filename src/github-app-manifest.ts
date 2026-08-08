// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * GitHub App **manifest** flow (M2, one-click create).
 *
 * Instead of hand-filling the "New GitHub App" form, we POST a pre-built manifest
 * to GitHub; the user clicks confirm; GitHub redirects back with a temporary
 * `code`; we exchange it for the app's id, private key, and webhook secret.
 *
 * Custody stays flavor-A: this conversion runs **on the node**, so the private
 * key never reaches the control plane. The node keeps the key and only hands the
 * control plane the webhook signing secret (to verify inbound events).
 */

export interface AppManifestInput {
  name: string; // globally-unique app name
  url: string; // homepage / node URL
  hookUrl: string; // control-plane inbound hook URL (github_app)
  redirectUrl: string; // where GitHub returns the code (this node)
}

/**
 * Build the manifest GitHub reads to pre-configure the app: the permissions and
 * events the work queue needs, the webhook target, and the redirect back here.
 */
export function buildAppManifest(input: AppManifestInput): Record<string, unknown> {
  return {
    name: input.name,
    url: input.url,
    hook_attributes: { url: input.hookUrl, active: true },
    redirect_url: input.redirectUrl,
    public: false,
    default_permissions: {
      issues: "write",
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      // workflow_run failures → Fix failed CI automations (read-only on Actions).
      actions: "read",
      checks: "read",
    },
    default_events: ["issues", "issue_comment", "workflow_run"],
  };
}

export interface ConvertedApp {
  appId: string;
  slug: string;
  name: string; // human-facing app name (may differ from the requested one)
  pem: string; // the app private key (PEM) — stays on the node
  webhookSecret: string; // GitHub-generated; registered with the control plane
  htmlUrl: string; // the app's page, for the "Install" link
}

/**
 * Exchange a manifest `code` for the created app's credentials. GitHub returns
 * these **once**; the caller must persist the key + secret immediately.
 */
export async function convertManifest(code: string, fetchImpl: typeof fetch = fetch): Promise<ConvertedApp> {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "bivy" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub manifest conversion failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!data.id || !data.pem || !data.webhook_secret) {
    throw new Error("GitHub manifest conversion response was missing id/pem/webhook_secret");
  }
  return {
    appId: String(data.id),
    slug: String(data.slug ?? ""),
    name: String(data.name ?? data.slug ?? ""),
    pem: String(data.pem),
    webhookSecret: String(data.webhook_secret),
    htmlUrl: String(data.html_url ?? ""),
  };
}

/**
 * A tiny auto-submitting HTML page that POSTs the manifest to GitHub. The
 * manifest must be sent as a form field (it's too big/nested for a query
 * string), so we render a form and submit it on load.
 */
export function renderManifestForm(manifest: Record<string, unknown>, opts: { org?: string; state: string; nonce?: string }): string {
  const action = opts.org
    ? `https://github.com/organizations/${encodeURIComponent(opts.org)}/settings/apps/new?state=${encodeURIComponent(opts.state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(opts.state)}`;
  const manifestJson = JSON.stringify(manifest)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Creating your Bivy GitHub App…</title></head>
<body style="font-family:system-ui;padding:2rem">
<p>Redirecting to GitHub to create your Bivy app…</p>
<form id="f" method="post" action="${action}">
<input type="hidden" name="manifest" value="${manifestJson}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script${opts.nonce ? ` nonce="${opts.nonce}"` : ""}>document.getElementById("f").submit()</script>
</body></html>`;
}
