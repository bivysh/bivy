# Linear work queue

Bivy can dispatch Linear issues to the same hosted queue used by GitHub issues. Applying `bivy` (or `bivy/<node>`) creates an isolated coding session on your node; the agent commits, pushes, and opens a GitHub pull request.

## Setup

1. On the node, set:

   ```sh
   BIVY_LINEAR_API_KEY=lin_api_...
   BIVY_LINEAR_REPO=owner/repository
   ```

   The API key stays on the node. It needs read access to issues. The repository may instead be selected per issue with a Linear label named `repo:owner/repository`.

2. Create an account-scoped hook with `POST /account/hooks` and body `{"kind":"linear"}` (or use `POST /node/hooks` with an enrolled node token). Keep the returned hook ID and URL.
3. In **Linear → Settings → API → Webhooks**, create an Issue webhook with that URL. Copy the signing secret Linear generates, then register it with Bivy using `POST /account/hooks/<id>/secret` and body `{"secret":"..."}` (the equivalent node endpoint is `POST /node/hooks/<id>/secret`).
4. Create workspace issue labels named `bivy` and, optionally, `bivy/<node>` and `repo:owner/repository`.

## Routing and privacy

- `bivy` routes to the shared/default queue.
- `bivy/<node>` targets a node.
- `repo:owner/repository` overrides `BIVY_LINEAR_REPO`.
- Repeated update deliveries collapse into one pending run per Linear issue.

The control plane stores the Linear issue UUID, identifier, URL, repository mapping, and queue lifecycle metadata. It does **not** store the issue description. After claiming the item, the node fetches the current title and description directly from Linear using `BIVY_LINEAR_API_KEY`. Source code and Linear credentials remain on the node.
