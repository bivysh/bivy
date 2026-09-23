# Client deployment configuration and native integration

Core is the shared open-source client. Deployments choose their public endpoints
and presentation policy; core supplies generic configuration and platform hooks.
No server hostname or native platform selects a commercial product profile.

## Build configuration

`VITE_BIVY_CLIENT_CONFIG` is an optional JSON object, validated by Vite at build
startup and by the client. It is public, compiled configuration, never a place
for credentials. Unknown fields, unsupported versions, malformed values, and
unsafe origins fail rather than silently relaxing configuration.

For an account-based native wrapper targeting a compatible self-hosted server:

```bash
VITE_BIVY_CLIENT_CONFIG='{"version":1,"platform":"native","controlPlaneOrigin":"https://workspace.example","connectionMode":"account"}' pnpm run build:web
```

This example **does not** restrict login to email, hide account extensions, or
rewrite account messages. All server-supported login methods remain available.
The previous `VITE_BIVY_PACKAGED_CP` setting is rejected; update the shell and
client together rather than accidentally falling back to browser storage.

| Field | Default | Meaning |
|---|---|---|
| `version` | `1` | Configuration schema version |
| `platform` | `browser` | `native` explicitly requires the secure platform bridge; disables browser SW/install/Web Push paths |
| `controlPlaneOrigin` | unset/null | Optional HTTPS origin, without credentials/path/query/fragment; selects account/discovery/share API origin, not authentication or billing policy |
| `connectionMode` | `auto` | `account` forces account/relay routing and disallows direct/solo/hash-token/pasted account overrides; independent of platform |
| `authenticationMethods` | `password`, `github`, `email` | Intersected with server-advertised methods; cannot enable a method the server disables |
| `accountExtension` | `visible` | `hidden` suppresses opaque deployment-extension presentation/actions and blocks their dispatch |
| `signInDescription` | ordinary client copy | Optional deployment-owned sign-in description |
| `unavailableSignInMessage` | ordinary client copy | Optional message when no allowed server login method exists |
| `accountUnavailableMessage` | generic unavailable text | Optional replacement for errors whose extension actions are suppressed |
| `accountDeletionMessage` | generic irreversible account/data deletion warning | Deployment-owned cancellation/deletion disclosure; core does not promise to cancel external billing |
| `accountMessageRules` | empty | Optional ordered `{terms: string[], replacement: string}` rules for account/policy presentation only; literal case-insensitive substring matching, not executable regex/code |

A bare origin override remains a browser build. Native wrappers must explicitly
set `platform: native` and provide an origin for secure-storage isolation. An
account-only deployment must explicitly select `connectionMode: account`.
Browser builds with a configured origin initialize the account store before UI
mount; neither browser nor native builds silently reuse a saved bearer belonging
to a different origin. Existing ordinary OSS/PWA builds need no configuration.

Deployments such as Bivy Cloud own their settings in their build environment or
build-generated configuration, not as a preset in this repository. Server-side
authentication, quotas and entitlement checks remain authoritative. Presentation
rules do not filter user/agent transcript content or repository links.

## Native bridge (implemented by the shell)

Before the entry module executes, install `globalThis.__BIVY_PACKAGED_BRIDGE__`
with the `PackagedBridge` interface from `packages/web/src/packaged-client.ts`:

- `ready(): Promise<void>` hydrates synchronous `storage: Storage` from native
  secure storage. Never duplicate secrets in localStorage.
- `storage` implements the full Storage interface. Namespace data by app and
  control-plane origin. Queue every write/removal in order, including bearer
  tokens, room keys, and any legacy device-key fallback.
- `flush(): Promise<void>` resolves only after durable ordered writes/removals.
  A timeout must not allow later stale writes to resurrect a logged-out session.
  Prefer Keychain `ThisDeviceOnly`, with a deliberate accessibility class.
- `openExternal(url)` opens validated HTTPS URLs outside the privileged WebView.
  Generic native GitHub login and account-extension action URLs use this hook.
- `onForeground(callback)` hooks native app activation into the existing
  reconnect/reconciliation path, not a second socket implementation.

Native startup waits for hydration before importing the controller/UI. Missing
bridge, hydration failure, origin mismatch, and storage timeout fail closed—no
localStorage fallback. Sign-in flushes before publishing signed-in state;
sign-out flushes removals before reloading. Cancelled email attempts do not commit
late completions. Transient email-poll network errors retry until server expiry.

The existing non-extractable IndexedDB device-key path remains. Its iOS behavior,
secure-storage fallback, logout and origin isolation need physical-device tests.

### Optional store-owned account management

The host may provide `bridge.accountSubscriptions`:

```ts
{
  open(account: { token: string; controlPlane: string }): Promise<void>;
  synchronize(account: { token: string; controlPlane: string }): Promise<void>;
  clear(): Promise<void>;
}
```

`open` presents native management and resolves on dismissal; Settings then reloads
account state. `synchronize` resumes transaction delivery at startup/sign-in and
foreground without presenting a purchase prompt. `clear` stops observers and
removes in-memory account credentials on logout. Guard account changes, keep
credentials in secure storage, and make delivery retryable/idempotent.

This capability is independent of extension visibility. Prices, product IDs,
payment SDKs, receipt verification, entitlements, and deletion disclosures are
owned by the shell/deployment. Core supplies no paid access itself. Deployments
must configure accurate deletion/cancellation copy for their billing providers.

## Optional native notifications and incoming links

A host may expose `notifications` with `status(account)`, `enable(account)`,
`disable(account)`, `synchronize(account)` and `clear()`. `account` contains
`token` and `controlPlane`; status returns `{supported, subscribed, permission}`.
The shared Notifications settings retain account-wide event preferences. The
host must request OS permission only from `enable`, serialize registration and
logout, scope requests to its configured origin, and keep device tokens in
secure storage. Foreground/login synchronization must not prompt for permission.

`onOpenURL(callback)` delivers HTTPS session/run links, including a buffered
cold-start link. Core accepts only its configured origin, `/sessions/:id` with
an optional single `node` hint, or `/runs/:id`. Credentials, fragments, other
parameters and authentication routes are rejected. The privileged WebView is
never navigated to the remote URL. Session opens wait for sign-in/connection;
the server remains authoritative for account/session ownership.

The control plane optionally supports APNs via `APNS_ENABLED=1`, `APNS_TEAM_ID`,
`APNS_KEY_ID`, `APNS_TOPIC`, secret `APNS_PRIVATE_KEY` (P-256), and
`APNS_ENVIRONMENT=sandbox|production`. Missing/invalid enabled configuration
fails startup. No deployment hostname or commercial policy is built in.
Authenticated account clients use GET/POST/DELETE `/api/push/native`; POST and
DELETE carry `{token: <APNs hex token>}`. Node-scoped grants cannot register.
POST is rate limited, with at most 16 installations/account. Registrations are
bound to a hashed account login session; revocation/deletion cascades to the
registration. Delivery ignores expired sessions and installations not refreshed
for seven days. Account deletion also cascades; APNs 410 removes only the unchanged
registration revision. Stale rows are pruned by the existing auth janitor and
on the account's next registration.

Delivery shares existing entitlement and event-preference checks with Web Push.
APNs receives only generic alert copy and a validated opaque session/run route,
never prompts, session titles or tool output. Delivery is best-effort, bounded
to 32 concurrent HTTP/2 requests with 10-second timeouts. Expiration zero avoids
queueing stale account notifications at Apple; offline devices must recover
state when opening the app. Offline logout cannot retract an already delivered
alert: the host clears delivered notifications and retries registration removal,
while the server checks grant validity on each send. Operators should monitor
`[native-push]` rejection/unavailability logs, which omit device tokens and keys.

For Universal Links, configure `APPLE_ASSOCIATED_APP_IDS` as a comma-separated
list of exact Apple App ID prefixes + bundle IDs (e.g. `ABCDEFGHIJ.org.example.app`).
`/.well-known/apple-app-site-association` returns JSON for session/run paths only,
or 404 when disabled. The native entitlement must name the same HTTPS domain.
Provisioning and real APNs/Universal Link validation belong to the native host.

## Control-plane CORS

Explicitly opt in on a compatible server, for example:

```text
PACKAGED_CLIENT_ORIGINS=capacitor://localhost
```

Exact comma-separated origins only; no wildcard, null origin, or cookie CORS.
Authorization remains required. Investigate unexpected null origins rather than
broadening permission. This configuration does not deploy or change a server.

## Validation and remaining native work

- Configuration tests cover unchanged OSS defaults, policy/platform/origin
  independence, server auth intersection, and rejection of invalid configuration.
- Browser tests use the real UI with mocked APIs/bridges: explicit restricted
  deployment, generic browser/native login and account actions, external handoff,
  secure persistence, cancellation, startup isolation and subscription lifecycle.
- Ordinary browser/PWA, source-contract and core tests remain relevant.

These tests are not proof of Keychain, StoreKit, native APNs, WKWebView crypto,
real email/OAuth, live relay or background recovery. Native adapters and device
acceptance belong to the shell. No production deployment or release-pin change
is implied. Do not fetch and execute remote JavaScript to configure a native
bundle; existing hosted `runtime-config.js` flags are a separate mechanism.
