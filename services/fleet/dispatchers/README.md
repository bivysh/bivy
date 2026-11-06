# Dispatchers

Ready-made dispatchers for the [dispatch contract](../DISPATCH.md). Each is a
dependency-free Node script; point the fleet at one:

```sh
FLEET_PROVIDER=command
FLEET_DISPATCH_COMMAND="node services/fleet/dispatchers/<platform>.mjs"
```

Each was written against the platform's published API and is tested against a
stand-in for it (`test/dispatchers.test.ts`), not against the live service.
Run a machine through it once before relying on it, and expect platform APIs
to move.

| Platform | Script | Stop is | Needs |
| --- | --- | --- | --- |
| [Daytona](https://www.daytona.io) | `daytona.mjs` | stop (disk kept) | `DAYTONA_API_KEY`; optional `DAYTONA_SNAPSHOT` |
| [E2B](https://e2b.dev) | `e2b.mjs` | pause (disk kept, no compute billed) | `E2B_API_KEY`, `E2B_TEMPLATE` |

Every machine is labelled `bivy-app=<app>`, so one account's machines are
found and deleted together. Neither platform has separate volumes: the
sandbox's own disk holds `/data` across stops. Neither reports CPU from
outside the sandbox, so the fleet's awake cap is the bound on a busy machine.

## Daytona

- **Image:** with `DAYTONA_SNAPSHOT`, sandboxes start from that snapshot
  (build one with Bivy installed). Without it, each sandbox is built
  `FROM` the fleet's image, which must be public and carry a tag other than
  `latest`.
- **Size:** CPU and memory follow the fleet's size, capped at Daytona's
  per-sandbox maximum (4 vCPU, 8 GB).
- **Network:** a sandbox must reach your control plane and relay. On Daytona's
  tier 1 and 2, outbound traffic is limited to a fixed list of services and
  can't be widened per sandbox, so this needs tier 3 or above.
- **Auto-stop** is turned off: Daytona counts API calls, not a running node.

## E2B

- **Template:** build a template with Bivy installed (`E2B_TEMPLATE`). CPU and
  memory are the template's; the fleet's size is not used.
- **Lifetime:** `E2B_TIMEOUT_SECONDS` (default 86400) is how long a sandbox may
  run continuously; set it to your plan's cap. At the timeout it pauses rather
  than dies.
- **Stop** pauses without memory (the node has already exited); paused
  sandboxes are kept until deleted.
