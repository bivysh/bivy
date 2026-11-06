# Dispatch contract

With `FLEET_PROVIDER=command`, the fleet runs every machine operation through
a dispatcher program you supply (`FLEET_DISPATCH_COMMAND`). It's how a platform
that can start a Linux machine from an image and run a command in it (a
sandbox service, a container host, your own VMs) runs Bivy machines without a
change to the fleet. The dispatcher holds the platform's credential; the fleet
never sees it.

```
BIVY_DISPATCH_OP=<operation>  <FLEET_DISPATCH_COMMAND>  < request.json  > response.json
```

- The command runs through a shell, once per operation, with the fleet's
  environment plus `BIVY_DISPATCH_OP`.
- The request is a JSON object on stdin; the answer is a JSON object on stdout.
- Exit 0 to answer. Any other exit fails the operation; the first lines of
  stderr become the error the fleet logs and retries on.
- Each run has five minutes, and output is capped at 1 MiB.
- **Every operation must be safe to repeat.** The fleet retries after a
  half-finished launch, so "already exists" and "already stopped" are
  successes.

## Terms

- **app**: the fleet's grouping for one account's machines (on Fly, an app
  with its own private network). If your platform has no such grouping, use
  it as a label or prefix, and keep one account's machines out of another's
  network if you can.
- **machine**: one Bivy node. Report its state with a string: `started` or
  `starting` is awake, `created` is on its way up, `destroyed` or
  `destroying` is gone, and anything else (`stopped`, `suspended`, …) is
  asleep.

## What the machine must do

`createMachine` gets a `spec`:

```json
{
  "region": "iad",
  "image": "registry/bivy-runner:1",
  "size": "shared-4x-8gb",
  "files": [{ "guest_path": "/etc/bivy/relay.json", "raw_value": "<base64>" }],
  "init": { "exec": ["/usr/bin/timeout", "--kill-after=10s", "21600", "/bin/bash", "-c", "…"] },
  "volumeId": "",
  "metadata": { "bivy_account": "…" }
}
```

1. Start a machine from `image` (Linux with glibc, `bash`, and Bivy installed
   or installable by the boot script) at roughly `size` (see `src/sizes.ts`).
2. Write each of `files` (base64 `raw_value`) to its `guest_path`.
3. Run `init.exec` as the machine's main process. It starts the Bivy node,
   which connects out to the relay; nothing needs to reach the machine.
   **Run it again on every `startMachine`**: a woken machine starts its node
   the same way (Fly does this by re-running init; on a sandbox platform that
   drops processes on stop, keep the command on the machine, for example as
   `/etc/bivy/boot.sh`, and start it in the background after each start).
   The node runs in the background for hours, so use the platform's
   long-running or detached execution, and turn off any idle auto-stop that
   only counts API calls: the node tells the fleet when to stop it.
4. If your platform keeps a separate disk, mount it at `/data`; otherwise
   keep `/data` on the machine's own disk across stops. Sessions, sign-ins
   and installed tools live there.

The machine needs outbound HTTPS and WebSocket access to the control plane and
relay, and to whatever the agents use (model providers, your git host).

## Operations

| Operation | Request | Answer |
| --- | --- | --- |
| `describe` | `{}` | `{ "capabilities": { "stopsOnExit": bool, "keepsMemory": bool, "cpuReading": bool } }` |
| `ensureApp` | `{ app }` | `{}` |
| `ensureVolume` | `{ app, region, sizeGb }` | `{ "volumeId": "…" }` (`""` without separate disks) |
| `createVolume` | `{ app, region, sizeGb, name }` | `{ "volumeId": "…" }` |
| `extendVolume` | `{ app, volumeId, sizeGb }` | `{ "needsRestart": bool }` |
| `diskUsage` | `{ app }` | `{ "usage": { "usedBytes": n, "totalBytes": n } }` or `{ "usage": null }` |
| `createMachine` | `{ app, spec }` | `{ "machine": { "id", "state", "region" } }` |
| `updateMachine` | `{ app, machineId, spec }` | `{ "machine": … }` (a stopped machine's new image or boot payload) |
| `getMachine` | `{ app, machineId }` | `{ "machine": … }` or `{ "machine": null }` |
| `startMachine` | `{ app, machineId }` | `{}` |
| `stopMachine` | `{ app, machineId }` | `{}` (keep its disk) |
| `destroyMachine` | `{ app, machineId?, volumeId? }` | `{}` |
| `destroyAll` | `{ app, machineId? }` | `{}` (the machine, its disks, the app) |
| `busyApps` | `{ prefix, minutes, fraction }` | `{ "apps": [] }` (only asked with `cpuReading`) |
| `listApps` | `{ prefix }` | `{ "apps": ["…"] }` |

`describe` runs once when the fleet starts; a dispatcher that can't answer it
is a configuration error.

## Capabilities

- `stopsOnExit`: the machine stops by itself when its main process exits. If
  not, the node tells the control plane it's going to sleep and the fleet calls
  `stopMachine`, so an idle machine isn't kept running until its awake cap.
- `keepsMemory`: a stopped machine resumes with its memory, not only its disk.
- `cpuReading`: `busyApps` can measure CPU from outside the machine. Without
  it, the CPU guard has no reading and the awake cap
  (`FLEET_AWAKE_CAP_MINUTES`) is the only bound on a busy machine.
