# GitHub sign-in — setup (what you do once)

To enable "Sign in with GitHub" (mobile app, CLI, and the web client), register a
**GitHub OAuth App** and give its credentials to the control plane. ~5 minutes.

## 1. Create the OAuth App

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
(<https://github.com/settings/developers>). A personal OAuth App is fine; a GitHub
*App* is **not** needed.

| Field | Value |
|---|---|
| Application name | `Bivy` (anything) |
| Homepage URL | `https://app.bivy.sh` |
| Authorization callback URL | `https://app.bivy.sh/auth/github/callback` |

The callback URL **must match exactly** — same scheme/host/path, no trailing
slash. Then **Generate a new client secret** and copy both the **Client ID** and
**Client secret**.

> Scopes are requested per sign-in (the app pins none). Login asks only for
> `read:user` + `user:email`; the broader `repo` scope for the work queue is a
> later, separate consent.

## 2. Give the credentials to the control plane

Set these env vars on the **control-plane** deployment (the service behind
`app.bivy.sh`) and restart it:

```bash
GITHUB_OAUTH_CLIENT_ID=<client id>
GITHUB_OAUTH_CLIENT_SECRET=<client secret>
# Make the OAuth redirect_uri match the registered callback exactly:
PUBLIC_CONTROL_PLANE_URL=https://app.bivy.sh
```

`PUBLIC_CONTROL_PLANE_URL` matters: the server builds `redirect_uri` from it, and
GitHub rejects the login if it doesn't byte-match the registered callback. (If it's
unset, the server falls back to the `X-Forwarded-Proto/Host` headers — only
reliable if your reverse proxy sets them correctly.)

## 3. Deploy the control plane from `main`

The `/auth/github/*` endpoints must be present in the running build, so deploy the
control plane from `main` (after PR #21 merges). Verify:

```bash
curl -i https://app.bivy.sh/auth/github/start   # 302 → github.com  (501 = not configured)
```

A `302` to `github.com/login/oauth/authorize` means it's live and configured.

## How it works (mobile)

1. The app calls `POST /auth/device/github/start` → gets a one-time device id + a
   GitHub authorize URL, and opens it in an in-app browser.
2. You approve on GitHub → GitHub redirects to `/auth/github/callback` → the
   account is resolved by your **primary verified email** and the device login is
   completed.
3. The app polls `/auth/device/poll`, gets a session token, and you're in.

Because the account is keyed by verified email, signing in with GitHub on your
phone and a magic link on your laptop land on the **same account**.

## Seeing sessions from other nodes

Once signed in, the app reads `GET /sessions` (the control-plane session index)
and shows an **"Across your nodes"** list. For this to be populated:

- each node must run a build with the session-index advertiser (in `main`), and
- it advertises automatically when the relay is configured (`bivy relay:setup`).

Titles are end-to-end encrypted: the app decrypts a node's session titles only if
that node is paired on the phone (it has the room key); otherwise it shows a
generic label. Tapping a node switches to it.

## Troubleshooting

- **"GitHub sign-in is not configured" (501)** → env vars not set / not restarted.
- **GitHub error "redirect_uri mismatch"** → the callback URL or
  `PUBLIC_CONTROL_PLANE_URL` doesn't exactly match the registered callback.
- **"Couldn't complete GitHub sign-in — the authorization code could not be
  exchanged"** → the token exchange failed. Check the control-plane logs for
  `[auth] GitHub token exchange returned no access_token`; the usual causes are a
  wrong/rotated `GITHUB_OAUTH_CLIENT_SECRET` or a `PUBLIC_CONTROL_PLANE_URL` that
  doesn't byte-match the registered callback (the `redirect_uri` must be identical
  at `/start` and in the token exchange).
- **"GitHub didn't return a verified email"** → the token worked but no verified
  address came back. Check the logs for `[auth] GitHub /user/emails …`: a non-OK
  status means the granted token is missing the `user:email` scope (revoke the app
  under GitHub → Settings → Applications and sign in again, or authorize org SSO);
  "none were verified" means the GitHub account has no verified email address.
- **Signed in but no cross-node sessions** → the node isn't on a build with the
  advertiser, or relay isn't configured on that node, or you haven't paired that
  node on this phone (so titles fall back to generic labels but should still list).
