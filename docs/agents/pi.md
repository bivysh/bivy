# Pi

Bivy's native coding agent runtime (`@earendil-works/pi-coding-agent`). The
default agent and the deepest integration: tool approvals, model picker,
package installs, and resume all go through Bivy's own runtime code, not a
spawned CLI.

- **Runtime id:** `pi` · **Tier:** Supported · **In picker:** Yes

## Install

Nothing to install — Pi ships as a dependency of Bivy itself. There is no
separate CLI to fetch.

## Authentication

**Auth owner: Bivy.** Pi reads Bivy's own encrypted credential vault
(`.bivy/credentials/`, `credential-store.ts`) directly — no separate Pi login
file. Sign in once and every runtime that shares the vault (including Aider's
matching provider, and Claude Code's Anthropic credential) can reuse it.

```bash
bivy login              # menu: subscription (OAuth) or API key, then provider
bivy login anthropic    # or any other provider id, skipping the menu
```

Credentials stay on the node (see [key-management.md](../key-management.md)).

## Models

The full model catalog Pi knows about, filtered to providers you've signed in
to. Pick a model from the in-app picker, or set a default in Settings
(`defaultModel`).

## Resume

Yes. `bivy sessions` / `bivy resume` list and reopen a saved Pi session with
full history; the app's session list does the same.

## Known gaps

None specific to Pi — it's the reference integration every other runtime is
measured against in [runtime-support-matrix.md](../runtime-support-matrix.md).
`fork` (exporting a session to a different runtime) is not yet supported.

## Run it

Pick Pi in the agent picker, or:

```bash
bivy run pi
```
