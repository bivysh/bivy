# Packaged companion client integration

The shared web client can be built as a packaged, existing-account companion.
This is an opt-in profile; ordinary browser/PWA and self-hosted builds keep their
current sign-in, service-worker, and deployment-extension UI behavior.

## Build contract

```bash
VITE_BIVY_PACKAGED_CP=https://staging-app.bivy.sh pnpm run build:web
```

The setting must be an HTTPS origin without a path, credentials, query, or
fragment. It is public configuration, never a secret. It selects hosted relay
mode even when local assets are served from `capacitor://localhost` or the URL
contains `?local=1`. It does not grant authorization or change account policy.
Packaged builds ignore pasted/hash account-token/control-plane payloads; route
links must be translated into local session routes by the native host.

The app uses the configured origin for sign-in-method discovery, account APIs,
relay ticket minting, and public/share URLs. It does not register/update a browser
service worker or display a PWA install prompt. Web Push is explicitly disabled
in this profile until native notifications are integrated.

Remote/live-site wrappers do **not** get this profile merely because Capacitor is
present. Store distribution must use the deliberately built packaged bundle.

## Native bridge (implemented by the shell, not by core)

Before the entry module runs, install `globalThis.__BIVY_PACKAGED_BRIDGE__` with the
`PackagedBridge` interface in `packages/web/src/packaged-client.ts`:

- `ready(): Promise<void>` hydrates its synchronous `storage: Storage` view from
  native secure storage. It must not expose secret values through localStorage.
- `storage` implements the complete standard Storage interface. Enqueue every
  write/removal in order. Namespace data by app/environment/control-plane origin.
  This includes bearer tokens, room keys, and any legacy device-key fallback.
- `flush(): Promise<void>` resolves only after all previous writes/removals are
  durably committed; reject on failure. Ordering must remain correct even if the
  JS caller times out. The implementation must surface failures for later writes,
  not silently discard them. Prefer Keychain `ThisDeviceOnly` storage and choose
  the accessibility class deliberately for foreground-only use.
- `openExternal(url)` opens validated HTTPS URLs in the system browser. Do not
  navigate arbitrary remote pages into a privileged native WebView.
- `onForeground(callback)` registers the native app-active event and returns an
  unsubscribe function. Core sends it into the existing reconnect/reconciliation
  path instead of maintaining a second native socket.

Startup waits for hydration before dynamically importing the controller/UI.
Missing bridge, initialization failure, origin mismatch, or a 15-second storage
timeout fails closed with a retry screen—never with a localStorage fallback.
Sign-in flushes the token before publishing signed-in state; sign-out flushes
removals before reloading. A cancelled email attempt does not commit signed-in
state after a delayed secure-store flush. Transient poll network errors retry
until the server's expiry. An app process termination intentionally requires a
new email attempt: pending device-login secrets are not persisted.

The existing non-extractable IndexedDB device-key path remains in place. If core
falls back to its LocalStore key path, that path now uses the injected native
storage. Actual X25519/IndexedDB persistence and logout isolation require testing
on the minimum supported iOS version; a Chromium mock is not evidence of them.

## Control-plane configuration

Explicitly opt in on the test deployment:

```text
PACKAGED_CLIENT_ORIGINS=capacitor://localhost
```

Multiple exact origins are comma separated. HTTPS, `capacitor`, and `ionic`
origins are supported; no wildcards, credentials, paths, `null`, or HTTP origins.
Requests receive no credentialed-cookie permission. Allowed preflights are limited
to supported HTTP methods and Authorization/Content-Type headers; actual routes
still require their existing bearer tokens/tickets. Unknown origins receive no
CORS permission. **An Origin header is not an identity or authorization check.**

Changing this environment variable requires the normal reviewed deployment
process. This PR does not deploy or modify production/staging configuration.
If a real WebView reports a null origin, investigate the WebView/scheme setup;
do not solve that by globally allowing null origins.

## Companion presentation policy

Packaged clients expose email account login only. GitHub repository/provider
connections are not account login and remain available. If the server has no
email method, the UI says it is unavailable rather than offering GitHub/password
fallbacks. This UI policy does not disable server-side login methods for browsers.

Opaque deployment account-extension facts/actions are hidden; account identity,
devices, sign-out and deletion remain. Extension-action dispatch is also blocked
in the controller, so stale UI cannot open a purchase URL. Policy-error toast
actions are hidden and purchase-oriented errors are replaced with neutral account
availability text. Automation limit gates have neutral messages and no purchase
actions. This is presentation only: no quota, entitlement, or backend permission
is bypassed. User/agent transcript content and repository links are not censored.

## Validation and remaining native work

- Unit tests: packaged origin/presentation helpers and CORS allow/deny/auth cases.
- `test/browser/packaged-client.spec.ts`: real shared UI, mocked account API and
  in-memory native bridge; desktop/mobile, light/dark, email completion, transient
  polling failure, cancellation, secure-write failure, and startup isolation.
- Existing browser/PWA contracts and account/relay tests remain relevant.

The native adapter, real Keychain persistence, Universal Links, native APNs,
WKWebView crypto behavior, and real email/relay/background recovery are **not
implemented or certified by these browser tests**. They belong in the shell and
must be proved on a physical iPhone before completing the native acceptance gate.
The packaged asset's public `runtime-config.js` does not inherit the hosted
server's deployment flags; do not enable managed-compute UI by fetching/executing
remote JavaScript. A future allowlisted JSON configuration path may be needed
for deployment-specific optional features.
