# Capability recipes

Bivy is most useful when an agent needs more than a clean checkout. A Machine can
put the agent beside the environment you already use, while Bivy adds remote
continuity and unattended Runs around it.

These recipes exercise features that ship today. Bivy is 0.x, so check the
[runtime support matrix](runtime-support-matrix.md) before relying on resume,
model selection, approvals, sandboxing, or native discovery for a particular
agent.

## Before you start

Install and enroll each Machine:

```bash
curl -fsSL https://bivy.sh/install.sh | bash
bivy doctor
```

The examples assume macOS or Linux, a running background service, and the hosted
control plane. A [self-hosted deployment](self-host-quickstart.md) works too.
Commands containing `acme/api`, hostnames, or tokens use placeholders you must
replace.

## Work in the real environment

### Use a local service and database

Start the application exactly as you do for human development, verify it from
the Machine, then start the agent in that checkout:

```bash
cd ~/src/api
docker compose up -d db api
curl -fsS http://localhost:3000/health
bivy run claude --chat --workspace "$PWD"
```

From the app, give the agent a concrete task:

```text
Reproduce the failing account-creation request against the local API on port
3000. Inspect the development database, make the smallest fix, and run the
relevant tests. Do not modify shared or production data.
```

The agent sees what its process on that Machine can reach: the checkout,
loopback services, local sockets, CLIs, and credentials. Bivy does not copy the
database into a provider sandbox. It also does not add an OS isolation boundary;
a process adapter may have the full permissions of your user. Select an agent
and protection level using the [runtime support matrix](runtime-support-matrix.md)
and use disposable development data.

### Reach a private network without exposing it

Connect the Machine to the VPN or private network first and prove the target is
reachable locally:

```bash
curl -fsS https://catalog.internal.example/health
cd ~/src/catalog-client
bivy run codex --chat --workspace "$PWD"
bivy link
```

Scan the link on your phone, then ask the Session to inspect the private service
or run the existing internal CLI. Your phone talks to the Machine through Bivy's
outbound, end-to-end encrypted Session relay; the internal service does not need
a public port. The agent's own provider traffic and any tools it invokes still
follow that Machine's network policy. See [Remote access](remote-access.md) for
the transport boundary.

### Use a local model on a GPU Machine

Bivy has a custom endpoint registry for Ollama, LM Studio, vLLM, SGLang, and
other OpenAI-compatible servers. Today that registry is projected into Pi's
model configuration; other agents may instead use their own local-provider
configuration.

For example, on a Machine with Ollama and an appropriate GPU:

```bash
ollama serve
# In another terminal:
ollama pull qwen2.5-coder:7b
curl -fsS http://localhost:11434/api/tags >/dev/null

curl -fsS -X POST http://localhost:4317/api/models/custom \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "providerId":"ollama",
    "name":"Ollama on this Machine",
    "baseUrl":"http://localhost:11434/v1",
    "api":"openai-completions",
    "models":[{"id":"qwen2.5-coder:7b","name":"Qwen 2.5 Coder 7B","contextWindow":32768}]
  }'
```

On a hardened multi-user host, add `Authorization: Bearer <token>` to the
request, using a token minted by `bivy token`; do not weaken local auth. Open
`bivy open`, start a Pi Session, and choose the newly registered model. Keep the
Bivy Machine and inference endpoint on the same host, or replace `baseUrl` with
a private URL that the Machine can reach.

Local inference availability is not a claim that every runtime supports every
model. The model server, context limits, GPU drivers, and model behavior remain
your responsibility. See the [Pi integration](agents/pi.md) and
[configuration reference](configuration.md#agent-selection).

## Continue from a phone with voice and files

Pair and optionally configure server-side speech recognition:

```bash
bivy link
bivy voice key groq       # optional; prompts without echoing the key
# or: bivy voice key openai
```

Then, in the phone PWA:

1. Open an existing Session and tap the microphone. With no Groq/OpenAI key,
   supported browsers can use built-in dictation; otherwise the Machine sends
   the recording to the selected transcription provider.
2. Tap the paperclip to send an image, log, PDF, or other file. Bivy writes the
   file into the Session's `.bivy-attachments/` directory and tells the agent
   where to find it.
3. Ask the agent to return a generated artifact as an attachment. Any agent that
   can invoke a shell command can run:

   ```bash
   bivy attach ./out/report.pdf --caption "Database analysis"
   ```

   Images render inline; other files become downloadable chips on the phone.
4. Tap the speaker on an assistant reply for browser read-aloud, or select the
   OpenAI reader under **Settings → Voice**.

Uploads and downloads travel over the same encrypted Session transport and stay
anchored to Session history on the Machine. Browser voice is device-dependent;
server transcription and OpenAI read-aloud send audio or text to the selected
provider and may incur provider charges. Canonical command details are in the
[CLI reference](cli-reference.md).

## Switch surfaces and import native sessions

### Keep a terminal Session and pick it up in chat

A Bivy-owned PTY preserves an agent's native TUI while making it remote-visible:

```bash
bivy shim install claude
claude
```

Detach without stopping it with `Ctrl-\` twice, then open the same live terminal
from the PWA. For a runtime that advertises takeover, choose **Continue as chat**
or run:

```bash
bivy takeover <terminal-or-session-id>
```

Takeover stops the PTY before resuming its pinned native Session, so there are
not two writers. The command returns the native resume command for a later hop
back to a terminal. Terminal attachment works for arbitrary TUIs; structured
chat takeover is runtime-dependent. See [Agent shims](agent-shim.md).

### Adopt work Bivy did not start

Claude Code and governed Codex can discover their own native Sessions on the
current Machine:

1. Open **Settings → Import session**.
2. Choose a discovered Claude Code or Codex Session.
3. Select **Adopt**. If the external process is still live, Bivy refuses takeover
   and shows the provider's terminal resume command instead.

Discovery reads bounded metadata and does not upload the transcript. Other
agents remain hidden until their adapters implement native discovery. Exact
current support is documented under **Native discovery** in the
[runtime support matrix](runtime-support-matrix.md#runtime-support-matrix).

## Fork or move a Session

In the PWA, open a Session's menu and choose **Fork / move…**. Select:

- a destination Machine;
- an agent;
- a model when staying on the same agent; and
- whether to retire the source after the destination confirms.

A same-Machine fork keeps both Sessions by default; a cross-Machine operation
defaults to a move. Bivy carries committed repository state, a bounded dirty
patch, and portable conversation history, then creates an independent branch or
worktree for the destination.

Forking is available across runtimes, but fidelity is deliberately explicit:

- a runtime-native transcript can provide full-fidelity continuation;
- supported destination stores can receive replayed portable turns;
- otherwise the new agent receives a bounded seeded continuation.

A cross-Machine fork can pause for missing repository access, an unavailable
agent, or model credentials. It never silently retires the source after a failed
import. Treat cross-agent/model/Machine forking as a 0.x capability and review
the destination's first turn before deleting the original.

## Use multiple Machines

Enroll each Machine into the same account and give it a capability-oriented
name:

```bash
# Run on each Machine after setup:
bivy rename macbook          # or: private-net, linux-ci, gpu-box
bivy status
```

`bivy nodes` lists account Machines when the control plane is configured. In the
app, select the Machine before creating a Session or Run; Automations can pin a
Machine as well.

For terminal-to-terminal launch over a trusted LAN, VPN, Tailscale, or SSH
tunnel, add a direct route. On the destination:

```bash
bivy token
```

On the source, use that token and the destination's private URL:

```bash
bivy nodes add gpu-box http://10.0.0.5:4317 --token '<token>'
bivy run pi --node gpu-box
```

The direct node API has no TLS, so do not expose it to an untrusted network.
`--workspace` and `--clone` cannot be combined with `--node`, because those
paths exist only on the source Machine. See the
[Machines CLI reference](cli-reference.md#bivy-nodes-addremove-).

Optional warm [Session replication](session-replication.md) is Beta and off by
default. It copies completed-turn transcript/checkpoint state directly between
two Machines over the encrypted relay. Failover is manual (`bivy promote`), and
at most the in-flight turn can be lost.

## Let events start Runs

### Failed CI

Create the starter, then replace its disabled example with a repository-specific
definition:

```bash
cd ~/src/api
bivy automation init
```

```yaml
# .bivy/automations.yaml
version: 1
automations:
  - id: fix-failed-ci
    name: Fix failed CI
    enabled: true
    trigger: github
    repo: acme/api
    instructions: |
      Reproduce the failed CI job, make the smallest safe fix, run the affected
      checks, and open a pull request. Never deploy.
    on:
      - event: workflow_run
        actions: [completed]
        conclusions: [failure, timed_out, startup_failure]
        workflows: [CI]
    routing:
      agent: claude-code-sdk
    safety:
      approval: risky
      sandbox: workspace-write
      maxAttempts: 2
```

Validate and simulate before upload:

```bash
mkdir -p .bivy/events
cat >.bivy/events/failed-ci.yaml <<'YAML'
kind: github
repo: acme/api
event: workflow_run
action: completed
conclusion: failure
workflow: CI
YAML

bivy automation validate
bivy automation test --event .bivy/events/failed-ci.yaml
bivy automation apply
```

`test` is local and creates no Run. `apply` encrypts the operator instructions
for the applying Machine. The GitHub App must have workflow events and
Actions/Checks read permission; existing Apps may need to be recreated. See
[Automations as code](automations-as-code.md) for matching and safety rules.

### GitHub or Linear issue

Connect the GitHub App:

```bash
bivy github:app-create --org acme
```

Install it on the repository, then label an issue `bivy` to use the shared
Machine selection or `bivy/gpu-box` to choose one Machine. Mentioning the App in
a comment also starts work when the source Automation permits it. Bivy prepares
an isolated worktree, runs the agent and declared checks, and reports the branch
or pull request. Use the [GitHub setup](github-setup.md) and
[GitHub Runs reference](github-work-queue.md) for permissions and trigger
restrictions. Linear uses the equivalent `bivy` / `bivy/<machine>` label flow;
see [Linear Runs](linear-work-queue.md).

### Schedule

Add a schedule definition to the same YAML file:

```yaml
  - id: weekly-dependency-review
    name: Weekly dependency review
    enabled: true
    trigger: schedule
    repo: acme/api
    schedule:
      cron: "0 9 * * 1"
      timezone: Europe/Oslo
    instructions: |
      Review outdated dependencies, make conservative updates, run all declared
      checks, and open a pull request. Do not publish or deploy.
    safety:
      approval: risky
      sandbox: workspace-write
      maxAttempts: 1
```

Run `bivy automation validate`, `plan`, and `apply` again. Schedules require an
explicit repository. Cron uses five fields and an IANA timezone; missed periods
catch up once rather than replaying every occurrence. One-time `schedule.at` is
also supported. See [Schedule semantics](automation-runs.md#schedule-semantics).

### Signed webhook

Add a definition with `trigger: webhook`, apply it, and save the endpoint and
one-time signing secret printed on creation:

```yaml
  - id: investigate-alert
    name: Investigate service alert
    enabled: true
    trigger: webhook
    repo: acme/api
    instructions: |
      Investigate with read-only diagnostics, produce a root-cause note and a
      tested patch, and do not deploy.
    safety:
      approval: risky
      sandbox: workspace-write
      maxAttempts: 1
```

Use a stable external event id as the idempotency key and sign the exact request
bytes. The complete runnable `openssl` + `curl` request and accepted schema are in
[Webhook recipes](webhook-recipes.md#send-an-event).

A webhook payload supplies bounded, untrusted event context; it cannot replace
the configured agent, model, sandbox, or operator template. Generic webhook
instructions reach the control plane in plaintext, so never include secrets or
customer data. Run reliability includes durable leases and bounded evidence,
but some retry/fallback improvements remain under active development; consult
[Automation runs](automation-runs.md) for current finality and idempotency
limitations.

## Bring a custom agent

### Existing ACP agent

If the executable already speaks ACP:

```bash
bivy agent add company-agent \
  --command company-agent \
  --transport acp \
  --args '["serve","--acp"]'
bivy restart
bivy run company-agent
```

ACP is the higher-capability path: when the agent implements the protocol
correctly, it can stream structured events, request per-tool approval, advertise
models, and resume Sessions. A custom ACP agent remains **Experimental /
Unverified** until independently validated.

### Headless process agent

For a command that accepts prompts on stdin:

```bash
bivy agent add review-bot \
  --command review-bot \
  --transport process \
  --prompt-mode stdin
bivy restart
bivy run review-bot
```

A process agent can stream output but cannot ask Bivy to approve its built-in
tools before they execute; it normally has the Machine user's OS permissions.
For a reviewable, distributable manifest, scaffold the Experimental `v1alpha1`
plugin format and run its diagnostics:

```bash
bivy plugin init ./company-agent --adapter acp
bivy plugin validate ./company-agent
bivy plugin doctor ./company-agent
bivy plugin test ./company-agent
bivy plugin install ./company-agent
bivy restart
```

Plugins are declarative and out of process; Bivy does not import third-party
JavaScript into the daemon. There is no public plugin registry, install script,
or stable v1 contract yet. See [Plugins](plugins.md) and the generic
[ACP adapter](agents/acp.md).

## Choose subscriptions, API keys, or local inference

Authentication belongs either to Bivy or to the upstream agent:

```bash
bivy login             # Bivy-owned OAuth or API-key choices
claude                 # Claude Code: use /login; can reuse Claude Pro/Max
codex login            # Codex: ChatGPT subscription or API key
```

Claude Code, Codex, Gemini CLI, and Qwen Code keep their native login/config.
Bivy can also store labeled provider keys, password-manager references, and
per-project presets:

```bash
bivy credentials add anthropic work
bivy credentials add openai local env://OPENAI_API_KEY
bivy credentials preset set project:acme anthropic work
bivy credentials preset use project:acme
```

Only Anthropic's Claude Pro/Max and connected ChatGPT/Codex subscriptions have
explicit bridges today; do not assume another subscription is portable between
agents. Local inference follows the GPU recipe above and avoids a hosted model
provider, but it does not change Bivy's Machine or relay trust boundary. See the
[credentials guide](credentials-guide.md) and each agent's page under
[Agent setup](agents/README.md).
