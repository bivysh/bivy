# Changelog

All notable changes to Bivy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Fewer steps from sign-up to the first answer.** Where the deployment offers Bivy Cloud, the cloud computer now starts right after sign-in, with no "Where should your agents run?" question; **Use my own computer instead** is on the AI sign-in card. Connecting the first plan finishes setup by itself (no **Continue**), and the app goes straight to the composer instead of a suggested first task. The agent now follows the plan you connect: ChatGPT picks Codex and Claude picks Claude Code, instead of keeping Pi, which then asked for a model.
- If Send still has to ask for a model, choosing one sends the message.

### Fixed

- **A first app no longer looks like a failure.** `bivy app shot` on a machine with agent screenshots off, or with no browser, now succeeds with no pictures and says why, instead of failing. Such a turn showed a red dot and "2 failed". It no longer tells the agent how to turn the setting on, so agents stop switching on a setting that is yours to choose.
- An app the agent presents shows one card in the chat, not a launcher card and a review card for the same app.
- Agents' step summaries (reasoning) render their Markdown, instead of showing `**Planning the layout**` with the asterisks.
- Choosing Claude Code or Codex no longer asks you to confirm that "Bivy couldn't check which sign-in this agent will use". The sign-in kind is only known once a session runs, so it no longer counts as reduced protection; it is still listed in the agent's details.

## [0.21.18] - 2026-10-28

### Security

- **Releases can't pick up a dependency published minutes earlier.** Release archives are resolved by npm, which has no cooldown; every version they resolve must now already be in the reviewed `pnpm-lock.yaml` or be past pnpm's one-day `minimumReleaseAge`, or the release fails.
- Agent bridges (Claude Agent SDK, Pi) install with `--ignore-scripts` on your machine, as do the relay and fleet images and CI's service installs, so a hijacked transitive dependency's install script never runs. Dependabot waits seven days before proposing a new version and now covers the fleet.
- **Signing in a terminal or app now asks the browser to approve it.** Device sign-in (`bivy` setup, the installed app) completed as soon as anyone opened its link, so someone could start a sign-in and send you the GitHub or email link: one click handed them your session. The browser now shows an approval page with a code that the terminal or app also shows, and nothing signs in until you approve.
- **`bivy update` checks each release's build attestation.** The checksum it already checked comes from the same release as the archive, so anyone able to replace release files could replace both. An update now installs only an archive that GitHub's attestation shows was built by Bivy's release workflow for that version, verified with Sigstore. `install.sh` makes the same check when the GitHub CLI is installed and signed in.
- The relay drops the `Domain` attribute from cookies a preview app sets, so one user's preview can't plant cookies on everyone else's previews under the shared preview domain, even from a modified node.

## [0.21.17] - 2026-10-28

### Added

- **Plugins can add widgets, tools, themes and guides**, not only agents. Ask any agent to make Bivy do more ("a standup checklist", "a theme like my editor", "let widgets show CI status") and it builds a plugin and installs it on your machine; nothing goes through a pull request or a release. Widgets are placed by name in any session, tools run for every agent (`bivy tools run`, and as MCP tools) and for widgets that need live data, `bivy theme set` restyles the app, and guides appear in `bivy guide`. `bivy plugin init --kind widget|tool|theme|guide` starts a working one, `bivy plugin dev` reinstalls on every change, and `bivy plugin install github:owner/repo` installs one someone shared. See [Plugins](docs/plugins.md).
- **Chat widgets.** An agent can put a small interactive page inside its reply — a picker, a form, a checklist — with `::view{src=widgets/x.html}`, and you use it right in the chat. It looks like the app in light and dark, can send your answer back to the agent when you click, remembers what you entered on every device, and goes full screen. Widgets run sandboxed, with no access to the app or the network, and speak the MCP Apps protocol, so views built for other MCP Apps hosts work too. Agents start one with `bivy widget init` and read your answers with `bivy widget state`. See [Chat widgets](docs/widgets.md).
- **`bivy contribute <issue>`** sets your agent up to work on Bivy itself: a checkout of `bivysh/bivy` on a fresh branch and a chat session whose first message is the issue and the repository's rules (`bivy guide contribute`). **`pnpm dev:all`** runs a node from the checkout and the web app together, on their own port and data dir, so a Bivy you already run is left alone. CONTRIBUTING.md now starts with what can be a plugin instead, and lists the tables most first changes are a row in; issues and pull requests have templates.
- **Find and share plugins without a registry.** `bivy plugin search [words]` lists GitHub repositories tagged `bivy-plugin` or `bivy-kit`, with the command that installs each. **Kits** carry a whole setup: `bivy kit export <dir>` writes this machine's plugins and chosen theme as one folder to push, and `bivy kit apply github:owner/repo` installs one.
- **Settings → this machine → Plugins** lists what agents installed and what each adds, removes one (after asking), and switches between plugin themes.
- **`bivy widget shot`** shows an agent its widget before you see it: rendered in the chat's own frame, light and dark, phone and desktop, with every error the page raised; on a machine without a browser it still checks that the page's scripts parse, and a plugin whose widget script does not parse is refused at install. In the chat, a widget that breaks now says so under it instead of staying blank.
- [Contracts](docs/contracts.md) lists every surface plugins, widgets and other code build on, with its version and how it changes; `examples/plugins/review-checklist` is a working plugin with a widget, the tool that feeds it, and a guide.

### Removed

- The control plane's `/janitor` proxy (`JANITOR_SERVICE_URL`, `JANITOR_PROXY_SECRET`) for a separate app that no longer ships with Bivy.

### Security

- **GitHub mentions trigger runs for collaborators by default.** A mention from anyone on GitHub used to queue a run on your machine unless you had restricted it. Unset now means collaborators with write access; choose "Anyone on GitHub" in Settings → GitHub App to open it up again.
- **A delegated run can't loosen its parent's safety.** `bivy delegate --approval never --sandbox danger-full-access` from a session in `risky` mode ran the child unattended and unsandboxed; children now keep the stricter of what they ask for and what the parent has. A project's `approvalFloor: autonomous` also stops `never`, which drops checks `autonomous` keeps.
- The node's GitHub App setup pages check the Host and Origin like the API does, and the callback only finishes a setup this node started, so another site can no longer swap in an app and private key of its own.
- The node ignores a forwarded client message that parses as a relay control message (a duplicate `"t"` key), and agent MCP configs Bivy writes are readable only by you.
- `install.sh` downloads over HTTPS only, redirects included.
- **A linking QR reaches its one machine and nothing else.** Its node-scoped grant was also accepted by the account's settings, automations, cloud-machine, GitHub App and push routes. Those now require an account session; a device linked only by QR signs in to the account to use them, push notifications included.
- Sign-in rate limits count the client address that `TRUST_PROXY` vouches for instead of any `X-Forwarded-For` header, so a direct caller can't dodge them by changing the header.
- **A relay can no longer pair itself with your machine.** Account pairing sent a reusable grant over the relay, so a malicious relay could replay it with its own key and receive the room key. Pair grants are now bound to the device key that requested them, single-use, and accepted nowhere else; sibling replicas and `bivy run --node` use them too. Devices and nodes on older Bivy versions must update before they can account-pair.

### Changed

- The README now leads with what Bivy lets you do: use the agents you already pay for and switch when one hits a limit, add any agent (your agent can write the adapter), sign in once on every machine, run on your computer, a cloud computer or a fresh runner, follow along from your phone, try the app, and let events start the work. Self-hosting the whole stack has its own short section, and the page is 320 lines instead of 540.

### Fixed

- `pnpm release` signs off its version commits (`git commit --signoff`), so the release follow-up PR passes the DCO check.

## [0.21.16] - 2026-10-28

### Added

- **New session in this repo.** The session menu (⋯) on a GitHub repository session starts a fresh session on the same repository and machine, instead of the repository you picked last.
- `FLEET_SWEEP_ORPHANS=0` stops the fleet deleting provider apps that no record of its own owns. Adopting machines another fleet created — a migration, or a restore — starts with an empty store, which the sweep would otherwise read as litter and delete along with every disk. The fleet name used to decide this on its own, and it also names the apps, so there was no way to adopt machines without renaming (and so orphaning) them.

### Fixed

- The control plane's internal compute and relay endpoints, and the fleet's API, now compare their shared tokens in constant time.
- **Answer an agent's question by just replying.** A message typed while a question card is open now answers it: the card closes and the agent reads your message as the answer, for every agent and for `bivy ask` (which reports `replied`). The agent used to stay blocked on the card until it timed out after 10 minutes.
- Codex chats can be steered from the composer again. Its app-server shim has supported steering a running turn, but the agent catalog the web app reads didn't say so, so the composer offered only Stop while Codex worked.

### Changed

- qs 6.16.1 (GHSA-6pq8-jhm2-2vcw: `qs.stringify` crash with `arrayFormat: 'comma'`).
- Agent pins: Claude Agent SDK 0.3.312, Codex 0.165.0.

## [0.21.15] - 2026-10-27

### Fixed

- The optional cloud-machine fleet no longer requires its settings to be present for stacks that do not run it: `docker compose up` interpolates every service's variables whatever the active profile, so `FLEET_IMAGE` and `DEPLOYMENT_COMPUTE_TOKEN` broke a plain control-plane + relay stack. The fleet still refuses to start without them, and says which are missing.

### Added

- **Self-host the cloud machines too.** The fleet that runs Bivy's cloud computers — create, wake, meter, guard, grow the disk, delete after notice, plus the per-work runners beside them — is now part of this repository as `services/fleet`. Point it at a provider token and a machine image and your own deployment hands out sleeping machines per account, exactly as Bivy Cloud does. Bring it up with `docker compose --profile fleet up`, or `kamal setup -c deploy/kamal/deploy.fleet.yml`. The fleet applies its own caps (hours a month, machines at once, runners per account, size classes, disk ceiling) so running one for other people is safe with nothing else configured, and it meters awake time itself and reports it at `/v1/compute/usage`. Adding a machine provider is one adapter and one row. See [cloud machines](docs/ephemeral-sessions.md#run-the-fleet-yourself).

### Changed

- **Bivy is MIT licensed.** Everything in this repository — node, CLI, web app, control plane, relay and the fleet that runs cloud machines — moves from AGPL-3.0-only to the MIT License. Use it, change it, run it for other people, build it into something else: no copyleft obligation, nothing to publish back, and no source-offer duty for a modified network deployment. The name is the one thing MIT does not hand over; "Bivy", the logo and "Bivy Cloud" remain trademarks, so a redistributed fork ships under its own name ([TRADEMARKS.md](TRADEMARKS.md)).
- **Contributions are DCO, not CLA.** The Contributor License Agreement is gone, and with it the copyright assignment it asked for. Sign off your commits (`git commit -s`) and you keep the copyright in your work, licensed to everyone under the same MIT license as the rest of the code. See [DCO.md](DCO.md).

## [0.21.14] - 2026-10-27

### Fixed

- **The repo picker lists your repos on a hosted machine.** A deployment-run machine holds no GitHub App key, so its picker said GitHub wasn't connected even after the hosted GitHub App was installed, and its button led to settings that already showed it connected. The machine now lists the repos the hosted App reaches, across every installation on the account, and offers the hosted App install when there is none. A long-lived machine also picks up an App installed after it first booted, for cloning and branches too.

## [0.21.13] - 2026-10-27

### Fixed

- **Connect your AI works on a node you open directly.** On a node served to the browser directly (`bivy tailscale`, or a local `?local=1` page), the first-run card said "Waiting for your computer…" forever with Sign in and API key disabled, because it waited for a selected machine id that direct mode never has. It now treats the open connection as the machine.
- Settings → Providers no longer shows the OAuth browser recovery switch when no account is signed in (a node opened directly); there it could not be turned on and snapped back.
- `BIVY_SETUP_SKIP_SERVICE=1` setup waits for the already-started node to answer, instead of giving up after one 1.2-second probe and reporting that the service could not be installed.
- **"Continue in terminal" works for OpenCode and Grok chats.** Grok's chats run over its ACP server, which had no terminal hand-off, so the option did nothing; OpenCode had none at all. Both now reopen the chat in the agent's own TUI (`grok --resume <id>`, `opencode --session <id>`). The resume arguments are one row of profile data per agent, shared by both paths.
- **OpenCode 2 keeps forks, imports and terminal takeover.** OpenCode 2 moved its sessions to new tables, so forking an OpenCode session, forking another agent's chat into OpenCode, taking a `bivy run opencode` terminal over as chat, and deleting its session all quietly stopped working. Bivy now reads OpenCode 2's sessions and writes them through `opencode session import` and `delete`. OpenCode 1 works as before.
- **Agents stop when their node does.** If the node crashed or was killed mid-session, the Codex app-server and every ACP agent (OpenCode, Grok, Gemini and others) kept running with no owner, each holding hundreds of MB. The shim now stops its agent and exits as soon as the node is gone.
- **A failed message shows the reason, not a stack trace.** When an agent rejected a prompt (for example Pi with no model login), chat and `bivy exec` got the raw stack with internal file paths. They now get the same short message or sign-in card as any other failed turn.

### Changed

- Dependency updates: Express 5.3.0, express-rate-limit 8.7.1, ws 8.22.0, MCP SDK 1.32.2, TypeBox 1.4.3, React 19.3.1, cronstrue 3.38.0 and vega-lite 6.5.0. Mermaid stays on 11.
- Claude Agent SDK 0.3.311, tested with Claude Code 2.1.311.

### Security

- **The relay's per-address connection cap counts clients, not the proxy.** Behind Caddy or kamal-proxy every relay socket came from the proxy, so the 50-connection cap was shared by every node and phone on the deployment. The relay now reads `X-Forwarded-For` from proxies listed in the new `RELAY_TRUST_PROXY` (Compose and Kamal set `uniquelocal`; unset trusts none), and compares its shared secret in constant time.

## [0.21.12] - 2026-10-26

### Fixed

- **A model error offers "Choose another model".** Errors such as "Model unavailable for this account" had no next step; the error card now opens the model picker (or the agent picker, for an agent that picks its own model).
- **A failed cloud startup shows its error once.** The startup card repeated the error that the chat's error card already showed, with its fixes. The failed step now says "See the error below."
- **Pi offers only the models your ChatGPT plan includes.** Pi's built-in list has ChatGPT models a plan can't use, and it could start on one, so every turn failed with "not supported when using Codex with a ChatGPT account". Bivy now reads the plan's model list from ChatGPT (the list Codex shows), filters Pi's models to it, and moves a session off a model the plan refuses.
- **An expired sign-in can be started again.** After a Claude or ChatGPT sign-in expired, its sheet kept showing the dead code with no way to retry short of reloading the app. It now offers "Start sign-in again".
- **Sign-ins wait as long as the provider does.** Bivy gave up on an unfinished sign-in after 10 minutes, while ChatGPT's device codes stay valid for 15, so a code entered late could never complete.

## [0.21.11] - 2026-10-26

### Fixed

- **Approval cards show the whole command on a phone.** A long command scrolled sideways, so `git push --force origin main` could read as `git push --force`. It now wraps.
- **Approving a Claude Code edit shows the change.** The card listed only the file; it now shows what is replaced and with what, without repeating the tool name.
- **File links in agent replies read as file names.** `[math.ts](/repo/math.ts:3)` showed as raw markdown because only web links were recognised. It now shows `math.ts`, with the full path on hover.
- **A Claude Code error no longer renames the model "<synthetic>".** The model pill keeps the model the session runs on.
- **A ChatGPT plan works with Codex on a cloud computer.** The chat's Codex never received the sign-in Bivy stored, so it said it had no OpenAI credential while the sign-in sheet said ChatGPT was connected. Codex now gets Codex's own login file from the ChatGPT sign-in before each turn, and OpenAI API keys too.
- **A Claude plan used outside Claude Code says so.** Anthropic answers other apps (such as Pi) signed in with a Claude plan with "Third-party apps now draw from your extra usage". Bivy showed that as "reached its usage limit". It now explains that the plan covers Claude Code only and offers to fork to Claude Code.
- **Previews stop failing quietly in the console.** The preview's own requests read an expired-access answer instead of tripping CORS, its server-errors poll backs off when access is missing, and its fonts load.

### Changed

- **The cloud computer wakes when you show up, not when you send.** Opening Bivy, coming back to it, or focusing the composer wakes a sleeping cloud computer for someone who works on it, so it is up by the time the first message goes. Picking a sleeping computer, or starting a new session after a cloud session, connects to it like any machine instead of going through the startup sequence. Deployments get the reason with each wake and are told when a boot is first really used (an agent turn or a terminal), so they can choose to meter from then.
- **Questions that ask you to do something answer with "Done".** A sign-in link, a code or a command to run used to need a typed answer; "Done" sends it, and "Reply with a message instead" opens a box. "Allow edit this session" now reads "Allow file edits this session", and a sub-agent's pull-request link uses the app's link style. Bar charts use slimmer, rounded bars.
- **Cleaner transcript, composer and settings.** An expanded "Worked" line no longer repeats "Worked" for each step inside it; table headers align with their cells; attachments and the protection pill use the app's line icons instead of emoji; the protection pill says "Machine default" instead of "Default"; and Send without a model explains why the model picker opened.
- **Settings → Providers & credentials leads with your plans.** With nothing connected it offers "Sign in with Claude" and "Sign in with ChatGPT" directly. Adding a provider lists those plans first and opens on subscription sign-in; import and OAuth recovery move under "Advanced". The page title matches its menu item. The API key field in "Connect your AI" saves with Enter.
- **Tidier automation editor.** Back sits left of the title and the Actions menu shares the header row instead of floating over the form. The "Run on" card is the machine picker, so the machine name shows once. Templates show what each one does.
- **The model picker puts the plans you pay for first.** With nothing connected it listed 41 providers alphabetically under an empty heading. Claude and ChatGPT now come first under "Use a plan you already pay for", named as in "Connect your AI"; the connect screen and its button use those names too.
- **"Connect your AI" is the one place to sign in.** After "Set up later", a missing sign-in showed a separate checklist ("Credential valid", "Authenticate"); it now shows the same card again, without "Set up later" the second time.
- **Plainer messages when an agent has no sign-in.** "Claude Code has no Claude sign-in or Anthropic API key on this machine yet" replaces "no Anthropic credential on this node … `401 Unauthorized`", and likewise for Codex and Grok. Claude Code is called "Claude Code" everywhere, not "Claude Code SDK".

### Added

- **Test sign-in for automated end-to-end tests.** A deployment that sets `TEST_SIGN_IN_SECRET` and `TEST_SIGN_IN_DOMAIN` accepts `POST /auth/test-login` for addresses on that one reserved domain, so an agent or CI can sign up, onboard and clean up a fresh account without an emailed link. It is off by default and can never sign in a real person's address.

## [0.21.10] - 2026-10-26

### Added

- **Pick Claude Code's and Codex's reasoning effort.** The effort picker the other agents have now lists the selected Claude or Codex model's own levels. A Claude pick applies right away; a Codex pick from the next turn.
- **A message sent while Codex works joins the running turn**, like Claude Code and Pi, instead of waiting for it to finish.
- **Slash commands from ACP agents.** OpenCode, Grok and other ACP agents announce their own commands (Grok's `/compact`, `/context`, `/goal` and more); the composer now offers them, and picking one runs it.
- **Token usage for ACP agents.** A Grok session, and any ACP agent that reports usage, now shows its token use (and its cost, when the agent sends one), like Claude Code, Codex and Pi.

### Fixed

- **Codex's questions reach you.** When Codex asked you something mid-turn, Bivy answered it with nothing. The question now shows on the question card and your answer goes back to Codex. A question it marks secret stays off the card.
- **Codex's requests for more access get an approval card.** Bivy answered a Codex request for network or filesystem access beyond its sandbox, and an MCP tool approval, with an empty reply. Sandbox requests now ask you in every approval mode except "never", and MCP tool approvals follow the node's approval policy. An MCP server's own form is declined instead of answered empty.
- **Answers to an agent's question reach protocol agents.** For agents Bivy drives over its agent protocol, an answered question card was sent back as a plain "allow" without the answer.
- **`bivy run <agent>` uses the agent install Bivy manages.** With `BIVY_NPM_GLOBAL_PREFIX` set, the node put `<prefix>/bin` first but `bivy run` still looked in `~/.local/bin` first, so a terminal session could start a different version of the agent than chat did, or none at all.
- **`bivy run claude` and `bivy run pi` use the same login as chat.** Chat signed these agents in with the login held by Bivy, while a terminal run used only the agent's own login. Bivy imports and refreshes that login, so the agent's own copy could stop working, and the terminal then said "Not logged in" or rejected every token while chat worked. Terminal runs now get the same credentials, and a login made in Pi's own TUI is still kept.

## [0.21.9] - 2026-10-26

### Fixed

- **Automations sign-in screen reads cleanly.** Its two explanation paragraphs ran together with no space between them. They now have one.

### Security

- **Stricter Origin check for tailnet names.** The node accepts a browser Origin on a `*.ts.net` name only when it is the node's own tailnet name, the one it serves the app on. Before, any `*.ts.net` Origin counted as local.

### Changed

- **Development toolchain updated.** Playwright 1.64, Vite 8.3.5, vite-plugin-pwa 2.0, ESLint 10.13 and Vitest 5.0.5. The app and its offline service worker build the same as before.

## [0.21.8] - 2026-10-26

### Fixed

- **API keys stored as references work with Pi.** A key added as `op://`, `env://` or `cmd://` (`bivy credentials add`) was invisible to Pi, which only read keys stored in the vault itself. Pi now reads a reference when it needs the key.
- **`bivy exec --session … --model …` switches the model.** `--model` was ignored when continuing a session; it now applies before the turn, and exec says so if the model isn't available.
- **A cancelled `bivy exec` turn says it was cancelled.** It printed the prompt as the answer and exited 0; it now exits non-zero with "The turn was cancelled."

### Security

- **Patched dependency advisories.** The control plane moves to body-parser 2.4.0 (a compressed request body with trailing bytes could tie up the server) and ip-address 10.7.5. The node and CLI move to fast-uri 3.1.9, hono 4.13.14 and ip-address 10.7.5.

### Changed

- **Agents tested against their latest releases.** Bivy now ships and release-tests Pi 1.4.0 (with its sibling packages moved together), the Claude Agent SDK 0.3.310 (Claude Code 2.1.310), Codex 0.164.0, OpenCode 1.19.4 and Grok 1.0.70.

## [0.21.7] - 2026-10-26

### Fixed

- **Saving an automation for Bivy Cloud is instant again.** Every save woke the cloud computer and paired with it before saving, so the button sat on "Waking Bivy Cloud…" even when this device already held its key. Saving now uses the held key right away. The current key is checked in the background afterwards, and the instructions are re-sealed if the computer was rebuilt with a new one. Bivy only waits for the cloud computer first when this device has no key for it, or its instructions were flagged unreadable.
- **Automations managed by `.bivy/automations.yaml` say so in the editor.** Saving one from the app was refused by the server, and only after any wait for the machine. The editor now explains that the file owns it and disables Save.

## [0.21.6] - 2026-10-26

### Fixed

- **Each browser tab keeps its own machine.** The selected machine was read back from storage shared by all tabs, so switching machines in one tab moved every other open tab's connection to it while their screens still showed the old machine. Those tabs then missed updates, like a finished sign-in, and could ask the wrong machine for a session. A new tab or a reload still starts on the last machine chosen.
- **Choosing Bivy Cloud survives a reload or a failed start.** After a reload the first-run screen asked again where agents should run. After a failed start, the header stayed "Offline" even once the cloud computer was online. Bivy now connects to the cloud computer as soon as it is online, and after a reload it starts it again.
- **The machine switcher says when no machine is chosen.** It showed "Offline — Machine"; it now shows "Choose a machine".

### Changed

- **The sidebar is readable on desktop.** Session rows had squeezed the title, a PR badge, the machine name and the age onto one line, so most titles were cut to a few letters. Desktop rows now match the phone layout: the full-width title on top, with agent, machine and repo on a quieter line below.
- **Resize the sidebar and the side pane.** On desktop, drag the inner edge of either panel to resize it. Arrow keys work when the edge is focused, and double-clicking the edge restores the default width. Each panel remembers its width across reloads.

## [0.21.5] - 2026-10-26

### Fixed

- **Links in chat keep their query parameters.** Message text was escaped before its URLs became links, and the link was escaped again, so `?a=1&b=2` reached the browser as a parameter named `amp;b`. Sign-in links lost their `client_id` this way.
- **Links in questions are tappable, and long ones wrap.** A question from `bivy ask` showed its text as plain text, so a URL could neither be tapped nor fully seen on a phone.
- **Links in an app preview open in a normal tab.** A preview's new tab inherited the preview's sandbox, which can break sign-in pages. It now opens as an ordinary page.
- **An expired sign-in says so.** A Claude or ChatGPT sign-in is dropped after 10 minutes, but the card kept saying "Waiting for sign-in…" and ignored a pasted code. The card now says the sign-in expired, and so does pasting a code for one.
- **A link to another machine's session opens it.** Opening or reloading a session URL while a different machine was selected asked the wrong machine and showed "Session not found". It now switches to the machine that has the session, as tapping it in the sidebar does.
- **Add a Machine notices the new machine.** The sheet stayed on "Waiting for it to come online…" after the install finished, and the machine list showed it only after a reload. The sheet now watches for the machine, switches to it and closes.
- **Pi recovers from a request made while it was installing.** A request that reached Pi before its packages finished installing broke Pi until the node restarted. Pi now says it is still installing, and a later request loads it.
- **The install command finishes without a terminal.** Run from a script, CI or an agent, the app's one-line command installed Bivy but stopped before connecting the machine. With an account token or claim code it now completes setup, which asks nothing in that case.
- **Setup checks the node is answering before saying it is running.** It used to print "Machine added and running" as soon as the service manager accepted the unit.
- **A cloud computer that is starting isn't treated like a broken machine.** While Bivy Cloud booted, the app said to run `bivy status` "on that machine", which nobody can do on a cloud computer. It now says the computer is starting and that a first start takes about a minute.
- **The model pill no longer says "unknown".** A node with no model set reports the id `unknown`; the composer now shows "Choose a model".
- **`bivy app publish` names the static folder it can't find.** A static directory is relative to the manifest's folder; a wrong path used to fail with "Could not read the app directory".

### Changed

- **Plainer agent descriptions in the picker.** Claude Code, Codex and Pi say which sign-ins they use instead of "operator-installed … governed tool calls".
- **A shorter update notice.** "Reload to use it. Unsent text is kept; attached files need adding again." replaces a sentence about browser storage.
- **The sign-in page uses the Bivy wordmark** and says agents can run on your own computer or, where offered, a cloud computer.

## [0.21.4] - 2026-10-26

### Security

- **undici 8.12.3, zod 4.6.7, body-parser 2.4.0 and DOMPurify 3.4.17.** They fix GHSA-xjj6-f33q-929c (undici: denial of service through an unhandled error on excessive content-encodings), GHSA-mrhx-c7xc-m3w5 (zod: memory exhaustion validating oversized constrained collections), GHSA-27r3-jxmh-p828 (body-parser: denial of service through trailing bytes after a compressed body), and GHSA-cg2g-xh64-v4q7 and GHSA-mrv2-3pqr-j5jr (DOMPurify: a SAFE_FOR_TEMPLATES bypass in shadow-root content, and event handlers left armed after an IN_PLACE hook removes a parent).

### Fixed

- **The Pi agent works again on fresh installs.** `pi-coding-agent` 1.0.4 accepts any 1.x of its sibling packages, and `pi-codemode` 1.4.0 removed an export it imports, so every bridge install since 2026-10-21 failed to load Pi with "does not provide an export named 'MCP_TYPESCRIPT_PREAMBLE'". Other features that load Pi failed with it: picking an agent did nothing, a confirmation said Bivy "couldn't check which sign-in this agent will use", and a first message could be dropped without an error. The sibling packages are now pinned to the version `pi-coding-agent` is built against.
- **Connecting your AI on your own computer says where the sign-in is kept.** After choosing Bivy Cloud and then picking your own computer, the card still said the sign-in stays "on this cloud computer". It now follows the selected machine.

## [0.21.3] - 2026-10-22

### Changed

- **A new cloud computer starts as soon as you pick it.** Choosing a cloud machine that doesn't exist yet used to wait for your first message before creating it, so the whole boot sat between Send and the first reply. It now starts when you pick it and boots while you type; the first message finds it starting or already up. A computer that already exists still wakes when the app connects to it.
- **The README and "Why Bivy" describe cloud computers.** They no longer say agents only run on your own machines. They describe the account's cloud computer, which sleeps when the work stops and keeps its disk, along with its hours on each plan and what its operator can and cannot see. The "not available at launch" section about ephemeral machines is removed.

### Security

- **MCP SDK 1.32.0.** It fixes GHSA-22jm-h49p-29qw, where experimental tasks weren't tied to the session that created them, and GHSA-46jr-4wx8-v453, where a single request within the size limit could exhaust memory during validation.

### Fixed

- **An issue run that opened a pull request no longer says it didn't.** When the agent's turn ended, a pull-request lookup started in the background; the issue run's own lookup then returned at once instead of waiting for it, and commented "Pushed … but didn't open a pull request" next to the PR. It now waits for the lookup in flight.
- **A machine that is gone no longer causes a server error when a peer sends it the sign-in vault key.** Runners finish in minutes, so a peer answering a runner's earlier request got a 500; it now gets a 404.
- **A handoff to a runner says why when it can't happen.** If the cloud computer can't open an item's instructions, it now logs that the automation needs saving again, instead of failing the handoff silently.
- **An agent's final reply no longer ends up inside its tool activity.** If you sent the same message twice and the second copy reached a running turn (a retry tapped twice, "Continue" sent again), Bivy took the second copy for the first. Everything the agent wrote after it was then saved ahead of the work done in between, so the reply showed above tool calls it came after. Each later turn put its reply in the same wrong place. The second message now stays where it was sent, and sessions already stored out of order are put back in order from the agent's own transcript the next time they're saved.
- **"Rate limit exceeded" no longer interrupts long sessions.** Every app connected to a machine received every large response and downloaded it page by page, including transcripts another device had asked for. In a long session with screenshots, a few opens across a phone and a laptop could push one app past the relay's 600 messages a minute, and the relay closed its connection. Machines now tag transcript replies with the request they answer, and an app only downloads its own. The app also keeps under the relay's limit itself: messages beyond 500 in a minute wait for the next minute instead of getting the connection dropped.

## [0.21.2] - 2026-10-20

### Changed

- **After a relay restart, phones wait for their machine instead of being turned away.** When every machine and phone redials at once, a phone often reaches the relay before its machine does. It used to get "Node offline" and retry with backoff; now the relay holds it for up to 5 seconds (`RELAY_CLIENT_NODE_WAIT_MS`) and connects it as soon as the machine arrives. If the machine doesn't come, the phone gets "Node offline" as before, and the app shows the same "connecting" state while it waits. `bivy_relay_client_node_waits_total` counts how holds end.
- **Relays reconnect a fleet with far fewer resources.** Each admission check against the control plane used to open its own connection, so after a relay restart with 3,000 nodes and 3,000 phones redialling, the relay held about 5,000 sockets to the control plane at once. It now sends them over a pool of 32 kept-alive connections. In that storm the relay used less than half the CPU, and the slowest admissions took 9–14 s instead of 23 s.
- **A new look for the web app.** Text is denser on desktop (13px; phones stay 15px), areas are split by thin lines instead of fills, and toolbars are one 36px row. Primary buttons are black on light and white on dark, and the only warm color is a spark that marks a running agent. The dark theme is a slate night, the light theme a soft white. The wordmark and the empty-session prompt use the serif; code uses JetBrains Mono, now bundled. Faint contour lines sit behind the empty new-session screen.
- **One line per turn for the agent's work.** Between your message and the answer, a turn's tool calls and interim messages fold into a single line. While the agent works it shows what it is doing; when it's done it summarises the turn ("Ran 4 commands, edited a file · 3 updates"). Tap it to open everything inline; it opens downward and doesn't scroll the chat. Files, apps and plans the agent produces stay visible outside it. "Show earlier messages" now counts what you see, so a turn's work counts once, and never opens mid-turn. Focus view is removed; this replaces it.
- **Sidebar.** Automations, Artifacts, Apps and Terminal sit at the bottom on desktop and at the top of the drawer on phones. Search is a button in the header that opens a search bar with a filter and a live count; Cancel or Escape clears it. Desktop session rows are one line and name the machine when you have more than one. New session is a pill with a round Settings button beside it.
- **Quieter cards for questions, approvals and stuck turns.** Cards from an agent are plain cards in the chat now. The header is a small label instead of an uppercase badge, colored only when it warns: "High risk", "Permanent", "Turn may be stuck". Only a permanent action keeps a red border. Options are one list of radio buttons (checkboxes when you can pick several), commands and codes sit in a soft inset, and Open terminal, Skip, Reject and Stop turn are ordinary buttons. A single question with plain choices is answered with one tap; there is no Send button unless you pick Other.
- **Session header.** The Chat / Terminal switch sits beside the session menu, so the title keeps its own line.
- **The "Make this repeatable" and notification offer cards no longer appear in sessions.** Automations are in the sidebar and notifications in Settings.
- **A message sent while the agent works now steers it. The follow-up queue is gone.** Send goes straight into the running turn, and the agent takes it into account as it goes. The panel above the composer is removed, along with its reorder, edit, "Send next", "Run in new session" and separate ⚡ Steer controls. So is the hidden scheduled message that delivered a queued follow-up after you closed the app. An agent that hasn't declared steer support only offers Stop until its turn ends.
- **Bivy is no longer published to npm; GitHub Releases is the only channel.** Releases and the `staging` channel publish only the self-contained archives, with their checksums and build attestations. `bivy update` on an older npm or tarball install runs the installer from `main` on the same channel, which moves it to the archive and keeps `~/.bivy`. Remove the old copy afterwards with `npm rm -g @bivy/bivy`. The daemon's update notice reads only the GitHub manifest, and `BIVY_RELEASES_URL` points everything at a mirror. The unpublished AUR package is removed; the installer works on Arch. A system package can still claim an install with `.bivy-install.json`, so `bivy update` leaves it alone. Agent bridges and npm-distributed agents still install with npm, using the one bundled with the archive.

### Added

- **Runners get sign-ins that outlast them.** A runner never refreshes a subscription sign-in (Anthropic and OpenAI rotate the refresh token, so a second machine refreshing signs the first one out). Before the cloud computer hands work to a runner, it now refreshes any account sign-in whose access token would expire within four hours and publishes the vault the runner reads at start, so the runner's agent doesn't stop mid-run on an expired token.
- **Account actions can complete in place and ask first.** A deployment extension's account action may now return `{ done: true, message? }` instead of a page to open: the app shows the message (up to 300 characters) and reloads the account view, so changed facts and actions appear at once. An action can also carry `confirm`, a plain-text question the app asks before running it. Settings, Automations and the error toast run actions the same way, and their buttons read "Working…" while one runs.
- **Automations run on runners too.** An automation's instructions are sealed to the machine it runs on, so a runner, which has its own key, couldn't read them, and automation work routed to the cloud always waited in line on the cloud computer. Now, when the deployment runs runners, the cloud computer hands each such item to one: it asks for a runner (`POST /node/runners`), pairs with it once it is online, re-seals the instructions under the runner's key and moves the item to the runner's label (`POST /node/work/:id/handoff`). The control plane only ever relays ciphertext. If no runner is free, it never comes online or the move is refused, the item runs on the cloud computer as before. A runner whose work never arrives ends itself after ten quiet minutes instead of running to its time limit.
- **Runners: queued work runs in parallel on its own machines.** When a deployment extension offers runners (`runners: true` in its compute profile), each queued item routed to the cloud gets a disposable machine of its own instead of waiting in line on the account's one cloud computer. Core enrolls the runner's node (`/internal/compute/runner-bootstrap`), labels the item for it, and asks the extension to launch it (`/v1/compute/runners/launch`). The runner keeps its data on its own disk, serves only its own label, never the shared queue, and ends itself once its work is done; Core then asks the extension to delete it (`/v1/compute/runners/release`) and removes the node when the machine is gone. A runner has its own room key, so only work it can read goes to one: issues, comments and CI failures, whose content the node fetches itself. Work sealed to another node, and continuations of a session another node holds, stay where they were. When the extension has no free runner, the item goes to the cloud computer as before. Runners appear in the hosted machines list, where they can be stopped.
- **A machine can be told never to refresh sign-ins.** With `BIVY_OAUTH_REFRESH=0` (set on runners), a node uses the access tokens it has but never spends a refresh token, and gets no Codex login from the vault, since minting one spends it. Anthropic and OpenAI rotate refresh tokens on every use, so a second machine refreshing a copy of a login signs the first one out; the login now stays with the machine that owns it.
- **Settings → Keys for agents lists the keys agents asked you for, and removes them.** Each key shows its name, what the agent asked for it, and when it was saved, never the value. Remove asks first and reminds you to revoke the key at the service too. The machine's own tokens (GitHub, model providers) are not listed and can't be removed here.
- **Agents hand you commands that need your password instead of asking for it.** `bivy ask --run "<command>"` shows the command on the card with an **Open terminal** button: a terminal on the machine opens with the command typed, not run, so you check it, press Enter and type your sudo password there, where the agent doesn't see it. Commands are one line with no control characters, so nothing runs before you press Enter. `bivy guide connect` now tells agents to install tools without root first (`uv tool`, `npm --prefix ~/.local`, `mise`, `brew`) and never to run `sudo` themselves.
- **Agents can hand you a sign-in or a manual step as a card.** `bivy ask --url <page>` puts an **Open** button on the question card, and `--code` shows a one-time code (a device sign-in code) with a copy button. With options like Done / "It didn't work", an agent can walk you through signing in to a CLI, turning on 2FA or approving an app from your phone. The new `bivy guide connect` playbook shows agents how to handle keys, device-code sign-ins, sign-ins that return to `localhost`, and a browser on the machine. The secret card's "Where to find it" link now uses the same `--url`.
- **Agents can ask you for an API key in the chat, without ever seeing it.** `bivy ask "<what to paste>" --secret NAME` (and the `request_secret` MCP tool) shows a card with a hidden input and an optional "Where to find it" link. What you paste is stored in the machine's encrypted vault as `NAME`, and the agent gets back only `secret://NAME`. `bivy secrets exec --env NAME -- <command>` runs a command with it in the environment. Values stored in the vault are now also masked wherever they appear in saved transcripts.
- **Install and update from GitHub, with no Node or npm on the machine.** `install.sh` now downloads this machine's release archive (Linux or macOS, x64 or arm64), checks it against the release's `SHA256SUMS`, and unpacks it into `~/.local/share/bivy/versions/`. `~/.local/share/bivy/current` points at the active version and `~/.local/bin/bivy` runs it. A fresh install takes a few seconds. `bivy update` downloads the next version beside the running one, checks that it runs, points `current` at it and restarts the node. If the node doesn't come up, `current` goes back to the version before, which stays on disk. The service unit and shims name `current`, so they keep working across updates. The daemon's update notice reads the channel's GitHub manifest. Re-running the installer moves an npm install over, keeping `~/.bivy`; if the old `bivy` still comes first on `PATH`, the installer names it. `BIVY_NPM_PREFIX`, `BIVY_NO_TARBALL_FALLBACK` and the old tarball migration are gone.
- **Releases ship self-contained archives on GitHub.** Each release, and the rolling `staging` prerelease on every merge to `main`, carries a `bivy-<version>-<platform>.tar.gz` for Linux and macOS on x64 and arm64. Each archive holds the app, its dependencies built for that platform, and a pinned Node runtime, so running it needs no Node, npm or registry on the machine. `SHA256SUMS`, a `manifest.json` and GitHub build attestations (`gh attestation verify <file> --repo bivysh/bivy`) come with them.

- **Add any ACP agent or CLI from `config.yaml`, with no restart.** An `agents:` entry now takes the same `adapter` block as a plugin manifest: `kind: acp` with a command for any [ACP](https://agentclientprotocol.com) agent, or `kind: process` for any other CLI, with optional output parser, resume and model flags. `bivy agent add` writes there (new `--parser` and `--resume-args` flags) instead of creating a single-agent plugin, and the agent is in the picker as soon as the file is saved. Installing or removing a plugin no longer needs a restart either. See [Add any agent](docs/add-an-agent.md).
- **Write an adapter for any agent in a few lines.** The JSONL turn format (parser `bivy-protocol`) is now documented as an adapter contract: Bivy runs your program once per turn with the prompt on stdin and reads events from stdout. It gains `session.started` (the adapter's own id, passed back as `{id}` to resume), `message.reasoning` and `usage`. A complete example is in `examples/agents/jsonl-adapter`, and `bivy guide add-an-agent` walks an agent through it.

### Fixed

- **Cloning a repo no longer fails with "could not read Username" after another node starts on the same data dir.** A second node started against `~/.bivy`, for example a dev or sandboxed run that could bind the port in its own network namespace, overwrote `bootstrap.json` and the git credential endpoint with its own secret and then exited. The running node kept serving but refused its own credential helper, so every clone, fetch and push lost its token until a restart. The node now checks every 10 seconds and re-publishes its secret once the process that overwrote it has exited. It never overwrites a node that is still running.
- **The picture sent with preview marks shows the screen you marked.** It used to be retaken by loading the page's URL in a fresh browser on the machine, which has none of the page's state: an app that keeps its data on your device, or a screen you reached by tapping around, came out as a different screen. The preview now sends a copy of the page as you see it (typed text and CSS-in-JS styles included, password fields as dots) and the machine draws the marks on that copy, with the page's scripts blocked. A page that can't send a copy is retaken as before.
- **Automations saved for Bivy Cloud are sealed with its current key.** Saving reused whatever key the device held for the cloud computer, so after the computer was rebuilt on a new disk (with a new key) its instructions were unreadable there and every run failed. Saving for Bivy Cloud now always fetches the computer's current key first.
- **Automations routed to the cloud computer, and work handed to runners, now run.** A machine the control plane enrolls on the user's behalf kept the id it generated locally, while work and automation templates are sealed to the id it was enrolled as, so it rejected all of them as "encrypted for a different node" and never handed any to a runner. Its boot payload now carries the enrolled id (`nodeId` in `relay.json`), and the machine adopts it at start. Machines set up with `bivy setup` are unaffected.
- **Work routed to the cloud no longer runs on whichever machine grabs it first.** Queued work starts on the shared queue and is moved to the cloud computer a moment later, so another machine serving the shared queue could claim it in between and fail, since the instructions are sealed for the cloud computer. While routing sends the shared queue to the cloud, other machines no longer list or claim that work, and work on the cloud computer's or a runner's label can only be claimed by that machine. The claim checks the label at claim time, so a stale list can't take it either.
- **A Claude session reopened after a full disk keeps its whole history.** If a write to Claude's transcript was cut short, Bivy stopped reading at that line. A reopened session then lost every later turn. New replies were placed above the missing ones, so the chat showed an old reply as the newest, and your later answers seemed to go nowhere. Bivy now skips the damaged line and reads the rest.
- **Machines come back within 30 seconds after a control-plane restart, not 5 minutes.** When the relay couldn't reach the control plane to check a connection, it reported "Unauthorized", and a machine that hears that slows its retries to once every 5 minutes. The relay now says "Control plane unavailable", so machines keep retrying at most 30 seconds apart. This needs no update on the machines. A ticket the control plane actually refuses is still "Unauthorized". The new `reason="control_plane_unavailable"` series of `bivy_relay_rejected_total` counts these.
- **Moving an automation to Bivy Cloud now moves its work there.** Saving an existing automation with Bivy Cloud selected kept its old machine label, so its runs still went to the old machine, which could no longer read the instructions now sealed for the cloud computer.
- **Many stalled phones at once can no longer run a relay out of memory.** The relay already cut off one socket that stopped reading once 16 MiB was queued for it, but a hundred stalled at once could still queue over a gigabyte between them. A relay-wide budget, `RELAY_MAX_TOTAL_BUFFERED_BYTES` (default 256 MiB), now cuts off every backed-up socket once the total passes it; healthy sockets are untouched. Cut-off sockets are dropped at once instead of closed gracefully, because a close frame waits behind the unread bytes and holds them for 30 seconds. The new `bivy_relay_buffered_bytes` metric shows how much is queued.
- **Settings, sheets and dialogs close inside a frame.** Closing waited for the browser to confirm a Back step, and inside a frame (Bivy viewed in an app preview) that step could land on the surrounding page, so the panel stayed open. Panels now close at once, and Back still closes them as before.
- `bivy restart`, and the restart at the end of `bivy update`, now really restarts a running node after rewriting its service unit. When the unit had drifted (an update moved paths, a config edit changed the environment), it was rewritten and enabled. `enable --now` only starts a stopped unit, so a running node kept its old code while the CLI printed "Service restarted".
- **Opening an old session no longer marks it "Last turn failed".** Once a closed session's worktree was cleaned up, reopening it started the agent in the deleted directory. The agent failed to start, and the session showed as failed even though you hadn't sent anything. Reopening now recreates the worktree on the session's branch, as it already did when the directory was removed some other way.
- **`bivy prune` no longer deletes recent sessions to make room for sub-agents.** Each sub-agent (delegated) session counted as its own session, so a parent that started a few sub-agents filled the keep window and pushed recent sessions out. A parent and its sub-agents now count as one session that is as recent as its newest member, and they are kept or removed together.
- **Automations whose instructions can't be read are flagged before they fail.** When a machine can't open an automation's encrypted instructions with any key it holds, it now marks the automation, and the list shows **Needs instructions** on it. Before, you only found out when a run failed. The machine checks at every start, after a device is removed, and whenever a run can't open its instructions. Saving new instructions clears the mark.
- **A device that missed a key change no longer reports readable instructions as lost.** A device that was offline when a machine changed its key still held the old key, so the automation editor said "Enter the instructions again" even though the machine could still read them. The editor now gets the machine's current key before it shows that message.
- **Images an agent puts in a message no longer stay blank, and they open full screen.** When a message had several images, one that resolved while an earlier one was still loading could leave the earlier one an empty box for good. Tapping an inline image, or an image the agent showed with `::view`, now opens the same image viewer as attachments, paging through that message's images.
- `bivy plugin init` and the example plugin pinned `requires.bivy` to a single minor release, so a plugin stopped installing at the next Bivy minor. The recommended range now runs to the next major.
- **The node no longer keeps every Claude session it has opened in memory.** The Claude Code runtime held each session it created or reopened, with its full transcript and images, until that session was deleted, so a long-running node grew with every chat it opened. A node up for 3.5 days held 146 of them, about 38 MB of its 185 MB JS heap, with the same transcript held several times when a session was reopened. A session now leaves memory when it closes.

## [0.21.1] - 2026-10-12

### Changed

- **First run asks where your agents run, then connects your AI.** When the deployment offers a cloud, the first screen after sign-in asks "Bivy Cloud or my own computer?". Picking Bivy Cloud starts your cloud computer right away, and "Connect your AI" (Claude and ChatGPT side by side, with API keys as a fallback) is on screen while it boots. Picking your own computer shows the install command, then the same step on that computer. A sign-in made on your own computer stays on that machine: it isn't added to the account's synced vault, so nothing about it is uploaded. A sign-in on Bivy Cloud joins that vault, still encrypted, so a replaced disk can get it back from another machine that is online, or an API key from this browser. Bivy cannot read it. Turn on sync for a credential in Settings when you add another machine. `provider.oauth.start` accepts `sync: "node"` for this. The unused first-run wizard (`FirstRunOnboarding`) is removed.

## [0.21.0] - 2026-10-10

### Added

- **An agent can put an app's preview inside its message.** `::view{app=<app id>}` frames a published app where the agent wrote it, instead of only offering an Open card beside the prose. The preview is prepared when you scroll to it, not when the message renders, so reading back through old history does not open apps you never looked at. If it cannot be framed — a browser that blocks preview cookies, an app that is no longer published, a terminal view — it says so and still offers to open it.
- **A chart can read a dataset from the workspace.** `"data": {"url": "data/use.csv"}` in a chart spec now plots that file instead of needing every row pasted into the message — `.csv`, `.tsv` and `.json`, up to 5000 rows. Bivy reads the file itself, under the same workspace-only rule as every other reference, so the chart still never fetches anything; a remote URL is refused and says so.
- **An agent can draw a chart in its message.** A ```` ```bivy ```` block holding a [Vega-Lite](https://vega.github.io/vega-lite/) spec renders as a chart, recognised by the spec's own shape — no Bivy-specific wrapper, so a spec written for anywhere else works unchanged. The chart takes its colours from the theme, so it reads in light and dark. The renderer is downloaded only when a message actually contains a chart. Data has to be in the spec: a chart cannot fetch a URL, which would make your browser load whatever address the agent named.
- **Data an agent places in its message renders as a table or a number.** `::view{src=data/use.csv}` shows the file as a table, reading exactly like one written as markdown — quoted cells, tabs and non-ASCII included, capped at 200 rows with a note saying how many were left out. A ```` ```bivy ```` spec of `{"type":"metric","value":…,"label":…}` shows a single figure at a glance, and needs no file at all.
- **An agent can place a file in its message, where it wants it.** Putting `::view{src=out/report.pdf caption="The quarterly summary"}` on its own line shows that file as a download chip right there in the reply, instead of as a separate card above the text. A ```` ```bivy ```` fenced block carrying JSON does the same for a small inline spec. Both render through one table of kinds, so a component Bivy doesn't know yet says so by name rather than leaving a hole in the message — and so does one whose file couldn't be read. `bivy attach` still sends a file on its own.
- **An image the agent regenerates now updates.** A file referenced again in a new message is re-read, so a reply saying "here is the updated chart" shows the updated chart instead of the first one. Only the newest message's references are re-read, and an unchanged file changes nothing.
- **An agent can show an image by writing it in its message.** `![A chart](out/chart.png)` now renders the file inline, wherever the agent put it in the reply — no tool call, no separate chip above the text. The path must be inside the session's workspace; the node copies the bytes into the transcript as the message lands, so the image still shows on your phone after the machine is gone. Remote `![…](https://…)` images work as before. A path Bivy won't accept (absolute, outside the workspace, or not an image) stays as the text the agent wrote. At most six images per message, 8 MB each; `bivy attach` is still there for bigger files and for sending something on its own.
- A Contributor License Agreement, checked on pull requests, and a [trademark policy](TRADEMARKS.md) for the Bivy name and logo. The code stays AGPL-3.0. (The CLA was later replaced by the [DCO](DCO.md), and the code relicensed to MIT.)
- **Fly machines can sleep instead of being destroyed (experimental, not yet used by any launch path).** A machine launched with `sleepOnIdle` gets a persistent volume for Bivy's data, the workspace and `HOME`. Worktrees, dependency caches and agent sign-ins then survive between uses. When idle the daemon stops the machine without reporting it settled, and the new `ProviderAdapter.wake` starts it again. Destroying the machine also deletes its volume.
- **One sleeping cloud computer per account (deployment-supplied compute).** A deployment extension can now run one machine per account that sleeps when quiet and wakes on use, instead of Core launching a machine per session. Core asks it to `acquire` the machine for a launch or queued automation and to `wake` it when a client connects. It serves the machine's boot payload from `/internal/compute/bootstrap`: a fresh enrollment token and a volume-backed node that sleeps instead of being destroyed. In the app, a session on a sleeping cloud computer stays usable, and sending wakes it. Deployments that don't opt in keep the existing behavior. See [self-host.md](docs/self-host.md#deployment-supplied-compute).

### Changed

- **A forgotten preview tab no longer keeps a cloud computer awake.** A preview counts as activity for two minutes after it last loaded something. An open live-reload connection on its own doesn't count, so the machine sleeps after the idle window as usual.
- **A sleeping Bivy Cloud computer says "Asleep", not "Offline".** The machine picker, terminal and import pickers, and Settings show it as asleep, and the Cloud row reads "asleep · wakes when you send". Screen readers hear "Asleep" on the status dot too.
- **The cloud computer stays awake while it's being used, and a preview link wakes it.** It used to sleep 10 seconds after the agent's last turn once no device had the session open, which also took down its previews. It now sleeps after the normal idle window (30 minutes). Someone loading or holding open a preview counts as activity. Opening a preview link while it's asleep starts it and shows a "Starting this preview" page that reloads by itself. Apps published with a `start` command come back on their own.
- **The Runs tab reads like the session list.** Runs are grouped under Needs attention, In progress, and then by day. Each run is one row with one status: tap it to open its details, where Cancel, Retry and Open session live. A failed scheduled run stops asking for attention once a newer run of the same automation exists. Work waiting for a machine shows up as its own group, and only when something is waiting. The filter pills, attention banner, Refresh button and "Hosted machines" panel are gone. The panel listed your cloud computer with a "Force destroy" button, but the deployment manages that machine, not you. Routing settings moved to a "Where runs happen" row at the bottom.
- **`bivy notify` only pushes to your phone; it no longer adds a "Message for you" card to the chat.** The card usually repeated the agent's last reply. The message argument is now ignored, and the push says the agent wants you to take a look. The agent note and onboarding prompts no longer ask agents to notify when they finish, because Bivy already pushes when a turn ends while you're away. `--json` output drops `id` and `posted`.
- **Pi 1.0.** Bivy now ships and certifies Pi 1.0.4 (from 0.99.2). Pi sessions, tool calls, resume, model switching and stopping a turn work as before. Opening a Pi session in the terminal now uses Pi's fullscreen view by default; set `tuiMode` to `"regular"` in Pi's settings to keep normal scrollback.
- **The machine picker shows Bivy Cloud as one place to run, not a list of machines to manage.** When Bivy Cloud is running, picking it reuses that machine. Otherwise it starts one when you send, and the row says so. The "Start a new … Machine" entries and the "N min remaining" countdown are gone. Your own cloud profiles are listed as "New …", with any running machines from them beside them. A session's machine label reads as "Runs on …" for screen readers.
- **Managed compute is supplied by the deployment extension.** The control plane no longer reads `MANAGED_PROVIDER_TOKEN_*`, `MANAGED_SESSION_*`, `MANAGED_AUTH_RUNNER_*`, `MANAGED_COMPUTE_MAX_ACTIVE_PER_ACCOUNT` or `MANAGED_GUEST_HARDENING_ATTESTED`. It asks the extension for the launch profile (`POST /v1/compute/profile`) and the provider credential (`POST /v1/compute/credential`). Admission checks now carry `activeManagedMachines`, so the extension enforces any concurrency limit. Credentials stay in memory only. The last unexpired one keeps teardown and reconciliation working through an extension outage. Without an extension there is no managed lane; BYO-cloud and personal machines are unchanged. See [self-host.md](docs/self-host.md#deployment-supplied-compute).
- **Cloud machines without the setup.** Bivy no longer asks you to bring your own cloud account. The "Connect a cloud provider" sheet, Settings → Cloud machine profiles, the per-device "Experimental cloud machines" switch, and running a queued GitHub item on a profile are gone. When a deployment provides cloud machines, Bivy Cloud just appears next to your machines in the picker and in automation routing ("Runs on"), which now says where the next run will go.

### Removed

- **`bivy suggest` and its "Suggested task" cards.** Agents now list next steps in their reply as plain text. The `suggest_task` MCP tool and the `/api/session/:id/suggest` route are gone. Suggestion cards in older sessions no longer render.
- **Cloud machines on your own cloud account.** The control plane no longer stores or validates users' cloud provider tokens, and no longer lets an account create or edit machine profiles (`POST/PUT/DELETE /account/ephemeral-configs`) or set a queue default (`/account/ephemeral-default`). It never launches a profile that used a user's own token; cleanup of any such machine still runs. The browser provider proxy (`POST /api/ephemeral/exec`, and the node's `ephemeral.exec` command), per-account warm standby machines, and the Hetzner and AWS adapters are gone; Fly remains for deployment-supplied compute. `GET /account/ephemeral-configs` lists only deployment-provided profiles. Docs: [ephemeral-sessions.md](docs/ephemeral-sessions.md) now describes cloud machines as deployment-provided.
- **A machine per session launched by the control plane.** Managed compute is now only the deployment's account machine: the control plane asks the extension to acquire, wake and release it (`/v1/compute/*`, profile `accountMachine: true`) and never calls a cloud provider itself. Gone: the in-core provisioner with its launch attempts, leases, TTL reconciler, orphan sweeps and usage settlement; the `/v1/compute/credential` call; the `ephemeral.provision` policy operation and the `ephemeral.*` lifecycle events; `POST /account/hosted-provision-now`; the Fly adapter's provision/destroy/wake (only the boot payload remains); the "Retry on a new Cloud Machine" action; and the runner-image and live-smoke workflows. Without an account machine, `/account/managed-machines` answers 503 and `/account/hosted-machines` is empty. Database tables are left in place.

### Security

- **A machine only runs instructions the control plane couldn't have written.** Queued runs now take their instructions from a template encrypted to the machine, from GitHub or Linear content the machine fetches itself, or from a prompt built into Bivy (CI failures without a template). Plaintext the control plane relays, such as a run's title or an unencrypted body, is no longer part of the prompt. Slack requests, which arrive unencrypted, run only on machines where you turn them on: `bivy config set automation.slackPrompts true`. **Breaking:** Slack requests stop running until you do.
- **The cloud computer holds its own keys; the control plane can no longer read its sessions or your model credentials.** It generates its room key on its own disk and your devices get it by pairing, as with your own computer. Model credentials reach it only through end-to-end vault sync or a sign-in on it; the "Allow unattended runs" escrow and its routes are gone, and the control plane deletes previously escrowed keys at startup. Trade-offs: a lost disk loses that machine's session history, saving a Bivy Cloud automation wakes the machine to pair with it, and a machine booted before this change keeps its old key until its disk is replaced. See [security-model.md](docs/security-model.md#known-limitations-for-0x).
- Each Fly launch now gets its own private network. Before, every Bivy app in a Fly org shared one network, so a machine could reach ports opened on other launches' machines (dev servers bound to `0.0.0.0`, for example) and list them through `.internal` DNS. Apps created before this change keep the shared network until they are recreated.
- The ephemeral runner image applies Debian security updates at build time and refreshes them weekly, even when the rest of the build comes from cache.
- The control plane's lockfile moves `proxy-addr` to 2.0.8 (GHSA-jqcg-44mw-7w3h: IP spoofing through IPv4-mapped IPv6 addresses in trusted subnets) and `moment` to 2.31.0 (GHSA-4p3w-j4w9-5jqw).
- `@modelcontextprotocol/sdk` moves to 1.31.0 (GHSA-6qxp-vccf-f47h: its OAuth client could send credentials to an authorization server chosen by the MCP server).

### Fixed

- **A device pairs again when a machine's key changes.** A machine that gets a new disk, such as a cloud computer whose disk was replaced, starts with a new key. A device that kept the old one used to loop on "Could not decode the machine response". After two connections where nothing decrypts, the device now drops the old key and pairs again through your account.
- **A subagent's work no longer shows up after the agent's final reply.** When a Claude Code session was reopened, its reloaded transcript left out the subagent's messages, so every later turn was placed ahead of them. That subagent's tool calls ended up stuck below the newest reply. They now go back where they happened, and sessions already affected are fixed the next time they're opened.
- **Long sessions with many screenshots no longer end in a pile of images.** Each time an agent retried a turn (for example after an "Overloaded" error), the session log saved the whole transcript again, every image included. One busy session's log passed 512 MB, after which the node could no longer read it. The chat then fell back to the agent's compacted context, and the app re-added every screenshot it had already shown at the end of the chat. The log now saves only what changed, reads oversized logs in chunks, and shrinks an existing oversized log the next time it's opened. A screenshot that came from a tool call is only shown with that call, and Focus view hides it along with the tool.
- **App servers no longer fill the session list.** Every time Bivy started a published app's server or desktop app, the process showed up as a session, and each exit left a saved run log behind. A server that kept crashing (for example, because its port was taken) added five rows every ten minutes. These processes belong to the app now: they appear in the Apps sheet with their logs, not in the sidebar. A crash loop also stays down after five quick restarts until the preview is opened again, instead of retrying every ten minutes.
- **Starting a sleeping or new cloud computer no longer fails after 5 seconds.** Core gave the deployment's `acquire` call the same 5 s budget as a policy check. Creating a machine takes longer, so the launch showed "Managed launch failed" while the machine was in fact starting. `acquire` now has 25 s.
- **Automations keep working after you remove a linked device.** Removing a device rotates the machine's encryption key, and automations saved before that could no longer be read. Their runs failed with "could not decrypt automation instructions", and opening one to edit showed `OperationError`. The machine now re-encrypts its automations' instructions under the new key. If instructions were already lost to an earlier key change, the editor opens with empty instructions and asks you to enter them again.
- **`bivy exec --session` follow-ups run again.** Every `bivy exec` into a session sent the same message id, and the node drops a repeated id as a duplicate for a day. A second `bivy exec --session <id>` was accepted but never reached the agent, and waited until it timed out. Each run now sends its own id.
- **Pi sessions no longer stop updating partway through.** If two of Pi's tool calls printed the same output, such as `(no output)`, Bivy mistook the second result for one it already had and dropped it. Every later message was then recorded out of order, so the bottom of the chat stayed on an old message while the agent kept working. Bivy now matches Pi's tool results by their call id. An affected session puts itself back in order on its next turn.
- The unit test for the web runtime config no longer imports the managed-compute module removed from the control plane, which broke the root unit suite on `main`.
- **Long error messages stay on screen.** An error with a long unbroken path, such as a missing-package error, grew wider than the chat and was cut off on both sides on a phone. Error cards now wrap and span the chat column, and the "Make this repeatable" and notification cards above the composer line up with its edges.
- **A new cloud session no longer rejects a model it actually has.** Before the first message, a session's agent hadn't started, so asking it for models returned a built-in placeholder list. On a freshly launched cloud machine that list could be missing the model you'd saved (for example Opus 5.5), and the launch stopped with "Your saved model isn't available on this machine". A session now briefly warms its agent and answers with the account's real models (bounded at 8 s).
- **A Bivy Cloud launch no longer stops at "Loading encrypted credentials" on a cloud computer.** The machine's launch milestones were only recorded for per-session machines, so the app never saw "credentials ready". They are now kept on the node for its current boot, cleared whenever it starts again, and returned with the account's cloud machine.

## [0.20.8] - 2026-10-06

### Fixed

- The web model picker recognizes configured models discovered by the current agent even when its initial catalog does not advertise model selection. Models from another agent cannot enable the picker.

### Added

- **Files: browse the session's workspace before anything is committed.** A new **Files** tab in the side pane (or **Browse files** in the session menu on a phone) shows the worktree the agent is editing, folder by folder. Uncommitted files carry the same + / ~ / − marks as Changes, folders say how many changed files they hold, deleted files still appear, and **Changed** narrows the tree to just the agent's work. Open a file to read it with syntax highlighting and line numbers, or see an image. The view refreshes after each turn. It is read-only and confined to the workspace: `..`, absolute paths, `.git` and symlinks that lead outside are refused.

## [0.20.7] - 2026-10-05

### Added

- **Backend views: review backend changes by seeing what they did.** Three new view kinds sit next to an app's web preview. **Requests** runs the API from your phone, using `.http` files. **Data** shows the rows that saved `.sql` queries return, through the project's own database client. **Logs** shows the server's output, with a marker at your last action. Bivy runs the safe requests and the queries before and after each agent run. The review card then lists what changed: an answer that went from 201 to 422, rows added or changed, errors the server logged. A backend-only run now gets a card too. Agents check the same views with `bivy app requests`, `bivy app data` and `bivy app logs`. Server errors also show in the web preview's Console, next to the page's own, from the moment the page was requested. A request can run inside a scenario: the scenario's simulated responses answer what they match, and the real server answers the rest.
- **Scenarios: open the live app in the state that matters.** A JSON file in `.bivy/scenarios/` names a starting point — a page, steps to take there, and API responses to simulate ("payments return 503", "orders are slow"). In the preview, the title becomes a scenario switcher, ↺ runs one again from the start, and the pill says when a response is simulated. Simulated responses reach only the browser that opened the scenario. A step that no longer works names itself and drafts a fix request. Agents list scenarios with `bivy app scenarios` and offer them on a review card with `bivy app present --try`, where **Try it** opens the preview in that state. Desktop apps have scenarios too: the app restarts with the scenario's arguments and environment, its API behind a proxy that applies the same rules, and the steps run as clicks, keys and menu items in its window.
- **OpenCode can run on a ChatGPT plan connected in Bivy.** A ChatGPT subscription signed in through Bivy now serves OpenCode too (`openai/gpt-5.6-sol` and the rest of the plan's models), with no separate `opencode auth login`. Your own OpenCode logins win and are never rewritten. `--model openai-codex/gpt-5.6-sol` picks the same model in OpenCode as in Pi and Codex.

### Fixed

- **Amp: structured transcript, working resume, and a mode picker.** Amp runs with its Claude Code-compatible `--stream-json`, so its tool calls and results show as cards instead of only the last message. Follow-up turns continue the same Amp thread again: execute mode had started archiving new threads, which blocked `amp threads continue`. Amp's agent mode (`low`, `medium`, `high`, `ultra`) can be picked like a reasoning level.
- **Zoom the image, not the app.** Image previews support pinch zoom, drag and wheel panning, plus zoom and fit controls, without moving the chat behind them.
- **Codex turns with a sub-agent keep their answer.** When a Codex sub-agent finished before its parent, the parent's turn ended early and its answer, plan text and sub-agent card were lost from the saved transcript. The sub-agent's own commands now also show under its card instead of as the parent's work.
- **A fork knows where its work is.** A fork works in its own copy of the repo, but its history still pointed at the original checkout, so the next agent could edit the wrong files. The history now points at the fork's copy and says so. A fork of a fork gets its copy next to its parent's instead of inside it.
- **A fork to another agent uses the model you picked.** For OpenCode and other ACP agents, the fork sheet listed no models and the fork started on the agent's default.
- **Sub-agent results read as the sub-agent's report.** Claude Code's hand-back frame and OpenCode's `<task_result>` wrapper are no longer shown around the report.
- **Tool cards show what the tool printed.** Pi's shell output showed as raw JSON with no exit code, and its card lost the command once output streamed.
- **No agent log dumps in the transcript.** An ACP agent's stderr (for example OpenCode's request errors) appeared as an "Agent output" card. It now shows only when the agent crashes.
- **Reopened Codex sessions don't show Codex's own context as your message.**
- **Agents launched by a node that was started from an agent's shell work normally.** The node passed that shell's session markers on to every agent it launched, so Claude Code thought it was a sub-session and stopped saving its transcript, which history, "Use chat" and forks need. The node now drops them at startup.
- **"Use chat" works for native `bivy run` sessions of every agent.**
  - **Codex:** it no longer picks up a sub-agent's thread.
  - **Codex:** it isn't blocked by Codex's background server ("thread already has an active writer").
  - **Pi:** sessions in your own Pi folder can be continued.
  - **All agents:** if a takeover fails, you stay on the run's screen instead of landing on an empty draft.
- **A native session continued in chat keeps its model and shows its earlier turns in order.** Claude Code and Codex sessions kept running on the agent's default model instead of the one the run used. Reopened Codex sessions show the commands, edits and sub-agents the agent ran, including code-mode calls. Grok's earlier turns no longer appear after the chat that continued them.
- **A message sent while an agent is still answering doesn't merge two replies.** For OpenCode, Grok and other ACP agents, what the agent had already said was dropped and the rest ran into the next answer.
- **A forked agent can read its full earlier conversation.** The transcript file a fork points to now sits in the fork's own `.bivy/` folder, inside its workspace, instead of a folder a sandboxed agent can't open.
- **Grok 4.7 is in the model list.**
- Agent suggestions appear below the response instead of above the final answer.
- Long suggestion descriptions can be expanded with Show more and collapsed with Show less.

## [0.20.6] - 2026-10-03

### Added

- **Side pane on wide screens.** On a desktop-width window (1200px and up), a session's Changes, Apps and Artifacts open in a pane beside the chat instead of a sheet over it, so you can read a diff or use a running app while you keep talking to the agent. App previews open inside the pane, with Draw and reviewer notes working as before. Toggle it from the new button in the session header or close it from the pane; the open tab is remembered. Narrower screens and phones keep the sheets.
- **Terminal tab in the side pane.** The side pane gains a Terminal tab: a shell in the session's workspace, next to the chat, so you can run a command while the agent works without covering the conversation. It is separate from the agent's own terminal (the Chat | Terminal switch). Switching tabs detaches and coming back reattaches to the same shell; End closes it. The terminal header's buttons now scroll into view when they don't fit, instead of being cut off on the left.
- **Changes view on phones.** Below the side pane's width, once the agent has changed files, the session's view switch under the title gains **Changes** next to Chat and Terminal (or next to Chat alone when the agent has no terminal view), with a count of changed files. It covers the column with the session's changes, full height, instead of a bottom sheet; the "N files edited" link opens it too. Your draft, the chat's place and a running terminal are kept underneath. **Review with agent** switches back with the prompt in the composer, and an approval or question from the agent brings the chat back on its own.

### Fixed

- **`bivy notify`, `bivy ask`, `bivy context` and `bivy app publish` work from an agent started with `bivy run` (or the agent shim).** The agent in a run got no `BIVY_SESSION_ID`, so these commands failed with "No session id", and `--session term-…` returned 404. A run's agent now gets the same session env a chat agent does: its pinned session id (Claude, Grok and Gemini), or otherwise the run's terminal id, plus a session token. The node accepts either id for these commands. A run has no chat, so a notice goes out as a push only, and the CLI says so. A question from the agent shows on the run's "running in the terminal" screen and can be answered there, including from a device that connected after it was asked.

## [0.20.5] - 2026-10-01

### Fixed

- **A signed-in Claude Code or Codex counts as ready on first run.** On a new machine whose agent was already signed in, the app said "Credential valid · The model credential is missing or invalid" and offered an **Authenticate** button that only opened the model picker, so the first-task card never showed, even though the agent answered fine. The check only looked at Bivy's own credential vault. It now counts the default agent's own sign-in (`~/.claude`, `~/.codex`, `~/.grok`). When Bivy can't see the login (Claude Code on macOS keeps it in the Keychain, or an agent reads an API key from the environment), the check stays out of the way instead of failing. Pi, which runs on Bivy's vault, still needs a credential there.
- **Installing or setting up Bivy from inside an agent session no longer tries to enroll with the session's token.** Every agent session has `BIVY_SESSION_TOKEN`, a token for its own routes, and the Connect a Machine command used the same name for your account sign-in. So `install.sh` or `bivy setup` run by an agent took the token path, failed to enroll, and restarted the node the agent was running on. The command's account token is now `BIVY_ACCOUNT_TOKEN`. Commands copied before this change still work, except from inside an agent session.
- **Re-running Connect a Machine on an installed machine doesn't ask you to sign in.** `bivy relay:setup` asked "Sign in with GitHub?" even when the command carried your account token or a machine claim. It now uses them.

## [0.20.4] - 2026-10-01

### Fixed

- **The first task's app opens once there's something to show.** "Open … and mark what's wrong" used to open an empty Apps sheet straight away: in a GitHub checkout the session works in its own worktree, so the server you already had running wasn't found there, and the agent's fixes wouldn't have reached it anyway. The agent now publishes the app from the folder it works in (`bivy app publish`), and the preview opens as soon as it's published.
- **Re-running `bivy setup` opens the app signed in.** With remote access already configured, setup skipped sign-in and opened the app on its sign-in screen. It now offers to sign in again (GitHub or email; the node keeps its identity), then opens the app signed in with this machine selected, as a first run does.

## [0.20.3] - 2026-10-01

### Fixed

- **Signing in to Claude Code during setup works on macOS.** When the installer ran `bivy setup`, answering yes to "Open Claude Code now to sign in?" crashed Claude Code with `EINVAL: invalid argument, kqueue`. Setup now hands the agent the terminal's own device, so the sign-in opens normally.
- **The agent setup opens for sign-in is a Bivy session.** Setup used to start plain `claude` (or another agent) for sign-in before the node was running, so the machine showed as offline and nothing you did there appeared in the app until you exited. Setup now brings the node online and opens the app first, then starts the agent with `bivy run`: you sign in and keep working in a session the app shows.

## [0.20.2] - 2026-10-01

### Added

- **Agent plans show as a checklist.** When an agent keeps a todo list or plan (Grok, OpenCode, Codex `update_plan`, or any ACP agent), the turn shows one **Plan · 2 of 4 done** line where the plan was last updated, and it opens into the steps with their status. `bivy tui` shows the same progress as one line per turn. Before, Grok and other ACP plans were pasted into the agent's thinking after every update, and Codex plans didn't show at all.

### Changed

- **What Tailscale gives you, stated plainly.** `bivy access`, the README and the docs now say that over Tailscale you get sessions, chat, approvals, questions, terminals and files, and that push notifications and app previews need Bivy hosted or your own server. The README no longer says the node can't serve the app.
- **The agent shim is your choice.** `bivy setup` asks before installing it, and the default is now no. Without a terminal to answer from, it isn't installed. If you say no, or there's no terminal, setup prints `bivy shim install <agent>` so you can turn it on later.
- **Forks carry the plan and the latest request.** A fork to another agent tells it where the previous agent's plan stands, and repeats the user's latest request in full when the summary had to shorten it.
- **Agents refreshed:** Claude Agent SDK 0.3.286, Codex 0.159.2, Pi 0.99.2.

### Fixed

- An agent CLI's own server is no longer offered as an app preview. OpenCode sessions showed a **Preview :4096** pill for OpenCode's internal server.

## [0.20.1] - 2026-09-30

### Added

- **The app matches your Omarchy theme.** On a machine running [Omarchy](docs/omarchy.md), Bivy takes on the desktop's theme (colors, and light or dark) and follows `omarchy-theme-set` live, on every device connected to that machine. It's the new **Machine** choice in Settings → Appearance, and the default when the machine has a theme.
- **`bivy tui`**: every session on this machine and on the nodes you added with `bivy nodes add`, in one keyboard-driven terminal view. Sessions waiting on you come first. The right pane follows the selected transcript live; press `a` or `r` to answer what the agent is asking, `i` to message it and `x` to stop it. It uses your terminal's colors, so it matches your theme.
- **Arch Linux and Omarchy package.** `packaging/aur/PKGBUILD` packages Bivy for the AUR as `bivy` (`yay -S bivy`). A pacman-owned install tells you to update through your AUR helper, from `bivy update` and from the app's Update button, instead of overwriting files pacman owns.
- **Self-host with Kamal.** `deploy/kamal/` deploys the control plane, web app, relay and Postgres to your own server with `kamal setup`, using the published images at the release you pin, one domain, Let's Encrypt TLS and no registry account. `kamal owner-login` prints your sign-in link. See [Self-host with Kamal](docs/self-host-kamal.md).
- **Your Tailscale machines, together.** Run `bivy tailscale` on each machine and the app's machine menu lists every one on your tailnet running Bivy; pick one to open it. Your own devices, signed in to Tailscale as you, now get in without pairing; pairing links are for other people's devices.
- **`bivy access`** shows how you reach a machine: this machine only, Tailscale, Bivy hosted or your own server. It also lists what that setup gives you (your phone, all your machines in one app, push notifications, shareable previews) and the next step. `bivy access tailscale | hosted | server <url> | local` adds a setup or turns remote access off. `bivy status` shows the same thing in one line, `bivy setup` now offers Tailscale when it's installed, and the app shows it under Settings → Machines. Notifications and Share tell you which setup they need when this machine doesn't have it.
- **`bivy tailscale`** puts your machine's Bivy on `https://<machine>.<tailnet>.ts.net`, reachable from any device on your tailnet, with no account, control plane or relay. The node serves the web app itself. Pair a phone by opening the one-time link it prints; `bivy tailscale devices` and `bivy tailscale revoke <id>` manage who has access. See [Tailscale](docs/tailscale.md).
- **Agents can rename their session.** `bivy title "<title>"` (MCP: `set_session_title`) renames the session the agent runs in, so a session titled from a vague first message can get a title that says what the work is. The agent instructions tell agents to use it when the title doesn't fit or the work changes direction. A title set this way, or by renaming in the app, now also wins over the automatic namer if that is still running.

### Changed

- **The first session runs the whole loop.** Once setup passes, the app looks for dev servers already running on the machine. If one is, **Open ‹app› and mark what's wrong** starts a session in that app's folder and opens its preview. Your marks go to the agent, and it sends back a fix and a share link. If nothing is running, **Make one small improvement** asks the agent for one small change, which it reports back with `bivy notify`. Both turn on notifications for the device first. This replaces **Show me around**. `bivy setup` now offers the agent shim, so typing `claude`, `codex`, `pi` or `opencode` starts a Bivy session. Notifications from those terminal sessions open the session when you tap them.
- **Suggested tasks: pick them, and the agent recommends where they run.** A suggestion can run here, through this session's sub-agents, or in new sessions. The agent passes `bivy suggest --run here|subagents|new` to pick the recommended action, which becomes the card's main button, and the other actions stay one tap away. Without it, a single card recommends *here* and several recommend *new sessions*. When an agent suggests several tasks, each card has a checkbox and the last card starts the selected ones together (e.g. **Run 3 as sub-agents**, **Do 3 here**). This replaces the ambiguous "Run all in parallel" button.
- **Apps pill above the composer.** A session's published apps and running servers now have their own pill at the right end of the band above the composer, instead of hiding in the run pill. When people leave reviewer notes on a shared preview, the pill shows **N new notes** until you open the Apps sheet.

### Removed

- Planning notes and one-off reviews that weren't user documentation are gone from `docs/`.

## [0.20.0] - 2026-09-30

### Added

- **`bivy context`** tells an agent where it is running: its session, agent, workspace, git branch, machine, published apps and the device that last drove it, plus the commands that reach the user. Add `--json` for one object an agent can parse.
- **`bivy help --json`** lists every command with its usage, scope (session, node or account) and whether it takes `--json`. `bivy help <command>` shows one command. A mistyped command now says **Did you mean: bivy sessions?** and exits 2.
- **`bivy notify "<message>"`** lets any agent message you: the text lands as a card in the chat, and when you're away your phone gets a push that names the session. Add `--urgent` to push even while you're looking. Each session pushes at most once a minute, and **Agent messages** in the notification settings turns these pushes off.
- **`bivy ask "<question>"`** puts a question card in the chat and waits for your answer. It works for any agent, not only those with their own ask-the-user tool. Add `--option` for choices, or leave them out and you type the answer. `--async` returns an id to wait on later.
- **`bivy guide`** has short playbooks for agents: showing the user something, talking to them, long work, other agents and machines, and automations.
- Agents that use Bivy through MCP (Codex, Gemini, OpenCode and others) now get **`notify_user`**, **`ask_user`**, **`suggest_task`**, **`app_publish`**, **`app_screenshot`**, **`app_present`**, **`bivy_context`** and **`bivy_guide`**, alongside `attach_to_chat`. They can also read the guides as MCP resources. Each tool runs the matching `bivy` command, so it behaves exactly the same.
- **`bivy fork`**, **`bivy approvals`**, **`bivy issues`** and **`bivy instructions`** bring the app's Fork, approval cards, GitHub issue pickup and agent instructions to the command line, for agents and scripts alike.
- **Session tokens.** Every agent session gets `BIVY_SESSION_TOKEN`, a credential that reaches only its own session's routes. Session commands and MCP tools use it, so they work on multi-user hosts and for agents that can't read the node's data directory. Each call an agent makes with it is recorded in the audit log (`bivy audit --session <id>`).
- **Agents always get their node's `bivy`.** Inside a session, a `bivy` from another install or an older version on the agent's PATH now hands off to the node's own CLI (`BIVY_NODE_CLI`). Agents no longer hit "Unknown command" for commands their node has.
- **`pnpm run eval:agent-ux`** runs real agents through small tasks: show a file, notify when done, ask before acting, suggest next steps, say where they're running. It scores whether each agent used Bivy well, and reports its Bivy calls and any `bivy` commands it tried that don't exist.
- **Agents can set up automations.** When an agent runs `bivy automation apply` (or the `automation_apply` MCP tool), your machine's approval mode decides whether you're asked first, just like any other action. The approval card lists each automation it would add, change or remove, and autonomous mode asks, as it does for deploys. Every apply leaves a note in the chat saying what changed, and if nobody was asked your phone gets a push too. `bivy automation apply --dry-run` shows the changes without applying them.
- `bivy attach` and `bivy suggest` take `--json` and `--help`, and `BIVY_OUTPUT=json` turns on JSON output for every command that has it. With JSON on, failures come back as `{"error":{"code","message","hint","next"}}` with a specific exit code (2 usage, 3 not found, 4 denied, 75 node unreachable), so an agent can tell what went wrong and what to run next.

- **Several notes in one message.** **Mark another** keeps the words you just wrote and hands the marking layer back, so "the button is too small" and "the total is misaligned" stay separate thoughts. Each mark keeps its number on the page and in the picture, and each becomes its own pin — so they are answered one at a time instead of as a lump.
- **Pins.** Marks you send from a preview now stay in the chat as a card with a state, instead of vanishing into a paragraph of selectors and coordinates. A pin holds a crop of what you marked and the words you sent, and answers itself: **Changed** when a later run changed the pixels you marked, **Element gone** when what you marked left the page, **Done** when you say so. Only evidence moves a pin — a run that changes nothing there leaves it open.

### Changed

- **A new version waits for you.** An agent turn no longer reloads the preview under you, taking your scroll position, half-filled form or open menu with it. **Show new version** appears on the pill instead, and taking it puts you back on the same page in the same place.
- **One gesture marks the app.** Point and Draw were two modes with a button each; press and hold anything in the preview to mark it, or drag on from there to circle it. Lifting without moving opens the note already listening. **Mark something** and the `C` key do the same without a gesture, and a long press inside a field or over selected text is left to the app.
- The README now opens with what Bivy is (remote access to the coding agents on your own machine, not an agent or a cloud dev machine) and its four parts, and covers one-gesture marking, pins, share-link durations, usage-limit handoffs, `bivy delegate`, and the commands agents use to reach you.
- **One pill over the app.** The preview's seven controls become the name, any waiting version and one menu holding Mark, Console, Compare, width, Reload and the rest — so the app keeps the screen it is being judged on.

## [0.19.3] - 2026-09-30

### Changed

- The **Handed over** line in a forked session now links to the session it came from ("Handed over · from Claude Code · <session>"), and **Forked from** in the run details opens that session too.

## [0.19.2] - 2026-09-30

### Changed

- Refresh the release-tested agent pins: Pi `0.99.1` (previously `0.87.1`), Claude Agent SDK `0.3.285` and Codex `0.159.1` (previously `0.3.284` / `0.159.0`). Pi 0.99 adds codemode, MCP servers and GPT-6.1 Sol, and "OpenAI Codex" sign-ins keep working under the same provider id.

### Added

- Forking to a different agent now offers that agent's models, so you can continue on a specific model instead of the agent's default. The fork sheet only lists agents that can run on this machine.
- When a fork hands the conversation to an agent as a text summary, the chat shows one **Handed over** line where the new agent takes over, instead of the whole summary as a message from you. Tap it to see exactly what was sent.
- That summary now points the agent at the full earlier conversation as a local file it can read. Previously it linked to the app, which agents can't open, so they spent their first turn trying to fetch it.

### Fixed

- Codex, OpenCode, Grok and other ACP agents: a turn that fails on a usage limit now offers **Fork to another agent** and **Retry when the limit resets**, marks the session as failed, and sends the error notification, as Claude Code and Pi already did. Codex's "try again at Oct 4th, 2026 5:18 AM" reset time is understood.
- ACP agents' reasoning stays where it happened in a reopened transcript, instead of all moving to the top of the turn.
- A Grok edit made without an approval prompt no longer shows a second "Created" card for the same file.
- An edit tool that writes a whole file (OpenCode, Grok) shows as **Created** with its line count. Work summaries count each file once ("edited a file" for a file created and then edited), and a new file's line count no longer includes the trailing newline.
- ACP agents' stderr output no longer shows raw terminal color codes.
- Tool calls Pi makes from inside another tool (codemode scripts, extensions using `ctx.executeTool`) stay nested under that tool after the session is reopened, not only while it streams.

## [0.19.1] - 2026-09-29

### Fixed

- An open app preview no longer closes when the chat refreshes after a turn, a reconnect or a resync.
- The transcript no longer redraws every message when its history refreshes, so scroll position and expanded cards are kept.

## [0.19.0] - 2026-09-29

### Changed

- Refresh the release-tested agent pins to the current upstream builds: Claude Agent SDK `0.3.284`, Codex `0.159.0`, OpenCode `1.18.33`, and Grok CLI `1.0.44` (previously `0.3.281` / `0.156.1` / `1.18.32` / `1.0.41`; Pi stays on `0.87.1`, still the latest).

### Added

- **`bivy delegate`**: an agent can hand a self-contained task to another agent, optionally on another of your machines, and get its answer, branch and PR back. Any agent with a shell can use it. `--to codex@mac,grok,claude@linux` sends one task to several agents and shows the results side by side, with **Use this** to continue from one of them. `bivy delegate machines` lists your machines and the agents each one has installed.
- Delegated work appears as a live card in the parent's transcript, with its status, answer and a link to the child session. The child session is named after its task, links back to its parent, and nests under it in the session list. Children inherit the parent session's approval mode and sandbox unless you pass `--approval` / `--sandbox`. The target machine's own policy still applies.
- App sharing: choose how long a share link works (1 hour, 1 day or 7 days), make view-only links without the feedback tools, and **Stop sharing** to end every live link at once.
- A reasoning-effort picker for ACP agents that offer one, such as Grok.
- Claude Code's hook blocks and warnings now show in the chat as notices.
- After a fork to a different agent, the new session shows the original transcript with its tool cards, not a raw text replay.

### Fixed

- Claude Code no longer re-sends your prompt when an answer happens to mention tokens.
- An image the agent reads with its file-read tool no longer shows up a second time in the chat.
- ACP agents (Grok, OpenCode): sub-agents nest under the call that started them, tool cards no longer get stuck on "Working", tool calls appear in the right order, and reopening a session no longer replays its history as new output.
- A session's model is kept when it is reopened, and bare model names (`--model gpt-5.6-sol`) now bind for agents that need a provider.
- `bivy prune` removes sessions and their worktrees together, so no session is left pointing at a deleted checkout.
- A Run whose agent turn failed is now reported as failed, not succeeded.

## [0.18.10] - 2026-09-29

### Added

- New accounts get a **Show me around** button once setup finishes: the agent looks at your workspace and suggests a few first tasks, without changing anything until you pick one.
- Agents can suggest tasks you start in one tap (`bivy suggest`): run one in a new session beside the current one, send it to this session, or run a whole set in parallel.
- A follow-up you queue while the agent is busy can run right away in its own session with **Run in new session**.
- While your first task runs, Bivy offers to turn on notifications, since the agent keeps working after you close the app.
- Tapping a "finished" notification for a run that changed an app now opens its live preview directly.
- Shared preview links show a small "Made with Bivy" strip under the app. A machine can turn it off with `bivy config set sessions.previewBadge false`; a control plane can limit that to certain plans with `BIVY_PREVIEW_BADGE_HIDE_PLANS`.

### Fixed

- The "Make this repeatable" suggestion after a first reply no longer disappears the moment it appears.
- Queued follow-ups no longer squeeze their text into a narrow column on phones.

## [0.18.9] - 2026-09-29

### Added

- Give every agent session your own instructions, on top of the repository's AGENTS.md: edit them in Settings → Agent instructions, and they sync end-to-end encrypted to all your machines.

## [0.18.8] - 2026-09-28

### Fixed

- Keep attachments you've added to the composer when you navigate away and come back before sending.

## [0.18.7] - 2026-09-28

### Added

- Offer a Fix sign-in button on credential errors, and refresh and settings buttons in the model picker.

### Fixed

- Keep the agent you pick for a new session instead of reverting to the machine's default, and finish selecting an agent once its install completes.
- Fall back to an agent's own local login when a stored OAuth token has expired and cannot be refreshed, instead of failing with an authentication error.
- Stop another agent's model list from flashing into the model picker while switching agents.

## [0.18.6] - 2026-09-28

### Fixed

- Keep preview annotations aligned with the content beneath them when app panels are scrolled.

## [0.18.5] - 2026-09-28

### Added

- Expose self-hosted service metrics on host-local ports for private monitoring.

### Fixed

- Load large conversations reliably with bounded, verified transcript transfers.
- Improve app-heavy session loading and navigation between preview sheets.
- Discover newly installed agent executables in running nodes without requiring a restart.
- Recover credential sync when a machine holds a stale wrapped vault key.
- Fix GitHub App connection loops on new machines and show repositories available through both GitHub App installations and user credentials.

## [0.18.4] - 2026-09-28

### Added

- Leave Point, Pen, and Box feedback on newly shared public app previews. Owners can review the notes and add them to a message; pictures are included only when screenshots are enabled, and public feedback never starts an agent run.

### Changed

- Simplify app discovery and sharing with published app counts, a shared Copy link dialog, and confirmation before revoking access.
- Refresh the app with a minimal black-and-white theme and warm accents, tidy settings and session actions, and improve image viewer controls.

### Fixed

- Improve preview drawing on touch screens, screenshot delivery, annotation notes, and fullscreen previews on desktop.
- Keep the iOS PWA status-bar background aligned with the selected theme.
- Complete signup when the machine, agent, credentials, and workspace are ready, without requiring a first message. Check credentials after syncing and accept usable alternative providers.
- Support sign-in approval in the original window for separately hosted app previews configured to use device sign-in.
- Keep repository credential resets before Bivy's Git credential helper so authenticated Git operations can use it reliably.

## [0.18.3] - 2026-09-27

### Fixed

- Keep Codex progress messages visible when reconnecting to a running conversation, and preserve the final transcript updates when a turn finishes.
- Make app previews fill the available mobile viewport.

## [0.18.2] - 2026-09-27

### Fixed

- Keep live conversations responsive during large file edits by avoiding repeated diff calculations for collapsed tool summaries. Detailed file diffs remain available in the activity inspector.

## [0.18.1] - 2026-09-27

### Fixed

- Restore app previews inside Bivy on supported iOS browsers and the packaged iOS app. Embedded previews now allow the packaged app to frame them and partition the app's own cookies so sign-ins and carts work in Safari. If a browser cannot keep preview cookies, the fallback to a separate tab expires after a week and retries after a browser update, bringing back the preview drawer, drawing, and voice feedback when supported.

## [0.18.0] - 2026-09-26

### Added

- Pick up on one device where another left off. When you open a session that another of your devices drove in the last half hour, a note above the composer says where ("Last active on Terminal on my-laptop · 2m ago"). If that device left an unsent draft, **Continue draft** moves it into an empty composer, so a half-typed prompt follows you from laptop to phone. It never blocks anything: whoever sends next is driving. The terminal lock screen also says which device last typed into the terminal. Devices name themselves ("iPhone", "Mac", "Terminal on my-laptop"); older nodes simply show nothing.
- `bivy app share [app-id] [--view <view>]` lets an agent mint the same reusable preview link as **Copy link**, and prints its URL and expiry as JSON. An automation started from an issue, a Basecamp or Slack thread, or a webhook can now post the running app back where the work came from. As with Copy link, anyone who has the link can use the app, including its live backend, for 24 hours or until you revoke access. The command repeats that warning, and `docs/apps.md` explains it.
- Reviewer notes from shared preview links no longer wait unseen. Notes arriving close together make one notification ("2 notes on Storefront") that opens **Apps** at that app; it carries a count and names, never the note text, and can be turned off under **Settings → Notifications → Reviewer notes**. At the end of the next run they're counted on that view's review card, or a card of their own, with **Add to message** and **Open in Apps**; nothing is sent until you send the draft. Notes are now saved with the app, so a restart doesn't lose them.
- `bivy app notes [app-id] [--view <view>] [--since <time>]` lets an agent read an app's reviewer notes as JSON, for example to post them back to the Basecamp or Slack thread an automation came from. Off by default: turn it on per app under **Apps → ⋯ → Agents can read notes**. Notes are untrusted text from anyone with the link, and the command says so.
- **Move to machine…** in the session menu moves a session to another of your machines in one step: the conversation, its branch and any uncommitted changes. It preselects an online machine and retires the original once the session is running there. The old combined entry is now just **Fork…**.

### Changed

- A session moves between terminal and chat in both directions without losing its place or getting a second writer. **Continue in terminal** from the app now opens the session in a terminal owned by the node, not by the device that opened it. It keeps running when that tab closes, any device can join it, and `bivy resume` on a laptop joins the same terminal. When another device takes the session back as a chat, an attached `bivy run`/`bivy resume` terminal says so and offers **Enter** to take it back, instead of printing "session ended". A terminal overlay watching it in the app switches to the chat.

### Fixed

- `bivy resume` on a session that is also open as a chat no longer lets both write the same conversation. The chat locks while the terminal drives it and reloads what the terminal wrote when it ends. Resuming a saved session from the CLI also keeps the session's own name and source in the sidebar.
- The standby machine now offers the **Continue here** that Settings has always promised for synced sessions. Opening a session that exists here only as a standby copy shows who owns it. If that machine is offline, **Continue here** takes the session over up to its last finished turn. If it's online, **Open on <machine>** takes you to the live session. A promoted session no longer lists as a standby copy.

## [0.17.2] - 2026-09-25

### Added

- **Copy link** and **Revoke access** for app web views in the Apps sheet. Opening a preview still uses a one-use launch link; Copy link gives a reusable link that opens the app on its own origin, outside the preview frame, so you can open it in another browser or inspect it with devtools. It works for 24 hours or until you revoke access, which ends every link, browser session and open connection for that view without removing the app.

## [0.17.1] - 2026-09-25

### Added

- Edit a webhook automation's pre-agent filter — command, trusted directory, and timeout — from the automation editor, instead of only through `bivy automation apply`. The filter lives in the encrypted instruction template, so saving an automation from the app no longer silently drops a filter that was applied from the CLI.

### Changed

- Quieter sidebar, chat, and composer. The sidebar puts **New session** as the primary action at the foot beside a round Settings button, promotes Terminal to a nav row, folds the Sessions heading and count into the search placeholder, and renders single-line rows that show a status dot only for states that want attention, a compact shape-coded PR mark, a source glyph for automation runs, and the machine name only when there is more than one machine. In chat, copy and read-aloud appear on a turn's final reply (interim replies reveal them on hover), the header drops its duplicate status dot, the run pill names only automation sources, and the composer shares the transcript column with a neutral Stop and a greeting on an empty draft. The run sheet shows cost to the cent and compact token counts. The dark theme is now true black, with neutrals carrying a faint cool tint matched to the accent hue.

### Fixed

- Keep a reopened session's thinking blocks where they belong instead of stacking them after the final answer. Claude persists each thinking block as its own assistant message; with no tool ids or reply text to match on, the reload couldn't recognize those messages as ones already in the stored log and appended them to the end of the turn. Thinking text now counts toward that match, so the reloaded transcript reads in the same order as the live one.
- Stop Run details from crashing the app for automation runs. An automation run's source (`automation:<uuid>`) is longer than the receipt format allows, which threw while rendering the panel and took the whole app down with it. Long `<kind>:<id>` sources now project as a kind plus a reference, and Run details hides the receipt row rather than crashing when a receipt can't be built.

## [0.17.0] - 2026-09-25

### Added

- Promote Grok to the fully certified tier. `grok agent stdio` is a first-party ACP server, so Grok now runs on the governed `ProtocolRuntime` by default (`acp.preferred`, gated on the installed binary evidencing the mode): per-tool Approve/Deny, native resume, and a live model list — the same bar Claude Code, governed Codex, Pi, and OpenCode clear. Joins the certification matrix release-tested against Grok CLI 1.0.41, with the full deterministic scenario fixture set in normal CI; the nightly drift report reads xAI's plain-text version endpoint (a new data-driven `latestUrl` upstream source for non-npm agents). The ACP launch path now also honors an agent's declared credential behaviors (Grok's vault-minted `auth.json` + preflight), which previously only applied to the pipe path. `BIVY_GROK_ACP=0` forces the structured-pipe fallback (effect-level governance, adapter-tested), and a pre-ACP binary degrades to it automatically.

### Changed

- Refresh the release-tested agent pins to the current upstream builds: Claude Agent SDK `0.3.281`, Codex `0.156.1`, Pi `0.87.1`, and OpenCode `1.18.32` (previously `0.3.270` / `0.154.0` / `0.85.1` / `1.18.30`). Regenerates the certification matrix, CLI agent manifest, and supported-agent docs from the single source of truth, and updates the bundled SDK/lockfile. Each pinned version installs and probes cleanly; the pinned-certification CI job and the opt-in live workflow validate the governed turn path.

### Fixed

- Stop reopened sessions from duplicating every turn. A native-store agent (Claude, Codex, Pi, OpenCode) reloads its full transcript on reopen, but that reload restates each turn with the agent's own timestamps and a different block shape than the live-streamed event-log base Bivy stored — so the id/timestamp union in `mergeBases` couldn't recognize the two serializations as the same conversation and concatenated them, showing the whole conversation twice after a reopen or daemon restart. `mergeBases` now folds a re-serialization by its serialization-independent atoms (the agent's own globally-unique tool-call/result ids and its text fragments, matched through a consumed multiset), collapsing the duplicate while still preserving a genuinely repeated message and a disjoint resumed turn. General to every native-store agent, no per-agent code.
- Persist a sub-agent's parent tool-call id so the nesting survives a reload. The live stream carried `parentToolUseId` on each `tool_call`, but the persisted overlay dropped it, so a reopened transcript flattened a sub-agent's work (the delegation and its steps rendered side by side instead of nested) — despite the catalog claiming nesting worked on reload. The persisted `tool_use` overlay now carries the parent id, so the work-log sheet nests a sub-agent's calls under the delegation that spawned them on reload exactly as it does live. Generic: any runtime whose `tool_call` event carries a parent id nests (Claude's `parent_tool_use_id` today).
- Preserve a protocol/ACP agent turn that fails mid-flight instead of losing it on reload. When a turn streamed a partial reply and then errored (a provider 4xx, an OpenCode ACP prompt rejection, an expired credential), the `session.error` path wiped the turn's content and persisted nothing, so a reopened session showed a blank "looks done, no reply" turn and the partial work vanished. The failed turn now keeps its partial assistant reply and tool activity and records a terminal error marker, so the reloaded transcript matches the live view (an inline error) for every protocol agent (OpenCode, Grok, Cursor, Amp, Gemini, …). The credential-preflight failure path gained the same reload-safe marker.
- Nest sub-agent tool calls to arbitrary depth in session transcripts. A sub-agent that itself delegates (a grandchild tool call) previously vanished from the work-log sheet because the nesting walk only descended one level; it now nests under its parent at the correct depth, cycle-safe, and the delegation's "N steps nested below" count reflects the whole sub-tree.

## [0.16.24] - 2026-09-14

### Added

- Nest a sub-agent's own tool calls under the delegation card that spawned them in session transcripts, instead of rendering them flat and unlabelled. Works live and on reload; general to any agent that surfaces a parent tool-call id (Claude's `parent_tool_use_id` today).

- Improve browser-first machine enrollment and first-task onboarding.

### Changed

- Refresh release-tested agent pins to the current upstream builds: Claude Agent SDK 0.3.270, Codex 0.154.0, and OpenCode 1.18.30 (Pi stays at 0.85.1). Each was validated with a real turn through Bivy's own runtime against live credentials before the pin moved.

### Fixed

- Keep updates from installing agents the user has not selected.
- Keep tool-result images out of portable transcript summaries when forking sessions.
- Separate assistant prose and reasoning that resume after a tool call with a paragraph break in transcripts for pipe/stream agents (Grok, Goose, Gemini, and the generic streams), so segments no longer run together (e.g. "…what it does.The workspace…"). Matches the governed protocol path.
- Preserve a tool's output in ACP transcripts (OpenCode and other ACP agents) when the command's stdout streams before the closing frame, instead of collapsing the result to a bare "completed" status.

## [0.16.23] - 2026-09-12

### Fixed
- Preserve image-only messages in cross-agent forks with a placeholder pointing to the full transcript.
- Remove the redundant mobile Automations sidebar background.
- Add a dedicated hosted GitHub App management link for repository access, with guidance for organization installations. Existing installations remain manageable even when a deployment cannot offer new installations.

## [0.16.22] - 2026-09-12

### Fixed

- Render Grok tool calls in transcripts with clean output and without duplicate cards.

## [0.16.21] - 2026-09-11

### Added

- Import existing Claude, Codex, and Grok logins through the CLI and Settings.

### Fixed

- Keep machine update actions busy after startup acknowledgement until the update completes.
- Keep the latest messages visible instead of hiding them behind earlier-message pagination.

## [0.16.20] - 2026-09-11

### Fixed

- Prevent Bivy outcome comments from triggering GitHub follow-up runs.
- Deduplicate policy-blocked issue runs and their notifications.
- Keep automation run details status consistent and refreshed.
- Surface failed Codex patches and live tool cards in exec JSON output.

## [0.16.19] - 2026-09-10

### Fixed

- Enable automation mentions in issue and pull request bodies, and prevent GitHub
  pickup labels from retriggering automations.
- Harden automation execution ownership, bounded retries, and lease recovery;
  persist pending results so acknowledgement retries do not rerun the agent.
- Use stable output branches across recovery and serialize lifecycle updates.
- Edit the selected automation definition safely, preserve locked instructions,
  and prevent duplicate Run now dispatches with clearer queued-state feedback.
- Improve automation dialog focus handling and approval safety explanations.

### Upgrade notes

- Deploy the control plane before upgrading runners. Upgrade all unattended
  runners to enable generation fencing, durable retry reservations, lease-deadline
  aborts, and pending-result recovery. External agent side effects remain at least
  once; existing random output branches are not renamed.

## [0.16.18] - 2026-09-10

### Added

- Select provider accounts and API keys for automations, with encrypted account
  labels and per-session credential routing. Update runners before configuring
  account overrides; older daemons do not support structured automation templates.
- Choose provider accounts directly in the model picker.

### Fixed

- Surface automation quota blocks and forward automation sources to deployment policy.
- Preserve transcript position and tool inspection during updates, and keep failed
  tool summaries labeled consistently.
- Reload the app after activating a PWA update, stabilize notification preferences,
  and respect notification settings for the app icon badge.
- Simplify provider OAuth sign-in and honor selected credential accounts.
- Stabilize terminal cleanup.

## [0.16.17] - 2026-09-09

### Fixed

- Keep fork progress visible from the session menu and agent picker until the new
  conversation is loaded, including cross-machine moves, and show failures in place.
- Keep activity dismissal and agent-selection confirmation in the current app
  session instead of navigating to another session or back to GitHub.
- Hide unattended credential controls when ephemeral machines are disabled.
- Install Python-based agents in isolated environments with uv and a compatible
  Python version, avoiding conflicts with system-managed Python installations.

## [0.16.16] - 2026-09-09

### Fixed

- Preserve conversation history in Codex model context when forking from another agent.
- Repair silent, empty Grok turns with corrected authentication, model selection,
  and streaming transcript handling.
- Align the app icon badge with sessions needing attention.

## [0.16.15] - 2026-09-08

### Fixed

- Respect gitignore rules when snapshotting fork workspaces.
- Load session title decryption keys without requiring each machine to be selected.

## [0.16.14] - 2026-09-08

### Added

- `bivy exec` now supports explicit workspace, session name, and model flags.

### Fixed

- Fresh curl installations no longer report success without installing Bivy when
  prerequisite prompts consume the installer input; setup failures are propagated.
- Require native terminal support and provision missing Debian/Ubuntu build tools,
  rather than silently installing without a working `bivy run` terminal.
- Repair macOS terminal spawn-helper permissions during installation.
- Report failed headless agent turns instead of returning an empty successful reply,
  and preserve explicitly supplied session names.
- Correct the fork-fidelity matrix and documentation for full same-runtime Codex
  and OpenCode forks.

## [0.16.13] - 2026-09-07

### Added

- Portable self-hosting with browser-based owner setup and sign-in, guided VPS
  deployment, and release bundles with pinned service images.
- Self-host deployment management scripts and Compose smoke checks for owner
  authentication, node enrollment, and relay connectivity.

### Fixed

- Preserve self-hosted owner access behind proxies and during upgrades.
- Keep node version reporting and release-channel update notices consistent.
- Resync the installed app badge when the app resumes.

## [0.16.12] - 2026-09-07

### Fixed

- Reject opaque, empty, multiple, and non-HTTP browser origins at the node API
  and WebSocket origin guard, while preserving native clients without Origin.
- Stop checkout updates on Git or dependency-installation failure without
  restarting the service, and propagate packaged-update download failures.
- Keep public-copy contract tests insensitive to Markdown line wrapping.

### Changed

- Production promotion now requires the canonical full CI workflow on the exact
  release commit, in addition to staging publication and environment approval.
- Clarified that npm-global and checkout updates do not automatically roll back.
- Expanded the README to explain Bivy's full product workflow.

## [0.16.11] - 2026-09-07

### Changed

- Refreshed the release-tested agent runtimes to the latest upstream releases:
  Claude Agent SDK 0.3.263, Codex 0.153.4, Pi 0.85.1, and OpenCode 1.18.29.
  Adapter flags and protocol modes were re-probed against each new CLI and the
  certification matrix, manifest, and docs regenerated.
- Clarified the launch scope around existing machines, Cloud access, and deferred
  provisioning.

### Fixed

- Improved onboarding, GitHub source setup, webhook authentication, and stale
  agent status handling.
- Fixed custom GitHub trigger labels, automation editor scroll jumps, and missing
  model labels; session badges now show automation trigger provenance.
- Machine updates no longer stay stuck when an acknowledgement is missing.

## [0.16.10] - 2026-09-06

### Changed

- Attachment loading now prioritizes newer files and explicit downloads, limits
  concurrent transfers, and reuses cached bytes across views and browser reloads.
- Remote session admission now consistently accounts for new manual, automated,
  and forked sessions while avoiding duplicate charges for delivery retries;
  quota-denied automation is parked instead of retried or rerouted.
- Ephemeral launch controls are hidden by default, with an explicit build-time
  opt-in for operators.

### Fixed

- Session and exec APIs now resolve declared agent aliases consistently, and
  `bivy exec` uses the same governed runtime selection as interactive chat.

## [0.16.9] - 2026-09-05

### Added

- Public, multi-platform control plane and relay images are now published from
  Core for reproducible self-hosted deployments.

### Changed

- The session experience now groups agent work into chronological turns, keeps
  the active session rail compact, and improves mobile composer, picker, queue,
  artifact, and transcript layouts.
- Cross-machine forks now navigate reliably to the destination session and keep
  browser history aligned throughout the handoff.
- Agent compatibility now covers current releases and preserves namespaced tool
  transcripts.
- npm-global updates now replace the installed package in place.

### Fixed

- Streaming JSON errors now surface as turn errors instead of leaving work in an
  ambiguous state.
- Machine updates, queued follow-ups, attachment visibility, artifact navigation,
  and missing automation-key recovery now behave consistently.
- Sidebar navigation and session controls now have improved keyboard and screen
  reader behavior.

## [0.16.8] - 2026-09-02

### Changed

- Cross-machine forks now transfer plain and unmanaged workspaces into isolated
  destinations, preserve files, symlinks, and modes, and support a configurable
  workspace size limit.

### Fixed

- Workspace forks now fail safely on inspection errors and avoid stale native
  transcripts while a transfer is in progress.

## [0.16.7] - 2026-09-02

### Added

- Bivy account login and logout are now available from the CLI, including
  interactive GitHub and email sign-in.

### Changed

- Model-provider authentication is now available through `bivy provider login`
  (also aliased as `bivy model login`), leaving `bivy login` for account access.

## [0.16.6] - 2026-09-02

### Changed

- Grok CLI sessions now preserve structured tool calls and results in live and
  persisted transcripts.

### Fixed

- Cross-machine session forks now keep progress, success, setup warnings, and
  failures visible while switching between source and destination machines.

## [0.16.5] - 2026-09-01

### Fixed

- Forked session handoffs now restore the source session when destination import
  fails, retain live transcript and unmanaged-workspace changes, and reject
  moves that would lose context.

## [0.16.4] - 2026-09-01

### Fixed

- Chat sessions can now start when a runtime defers model selection until the
  first query, including `bivy run claude --chat`.

## [0.16.3] - 2026-09-01

### Changed

- The automation editor now uses a wider two-column layout for execution
  settings, grows the instructions field with its content, surfaces agent,
  model & safety settings as a first-class section, and keeps save errors
  visible above the editor actions.

### Fixed

- Forking or moving a session across agents and machines now fails safe
  against context loss: the live transcript is preferred over stale snapshots,
  uncommitted changes are captured from unmanaged Git workspaces too, lossy
  moves are rejected, and the source session is restored when a destination
  import fails.
- Native terminal-to-chat handoffs now discover Pi sessions in Pi's
  per-workspace session layout, consistently offer Codex terminal takeover,
  and no longer let stale terminal lists resurrect an OpenCode terminal after
  takeover.

## [0.16.2] - 2026-09-01

### Changed

- Machine connection instructions now use one consistent card across onboarding
  and Add a Machine, show both sign-in options, and keep the dialog centered.
- The installer now streams npm progress and lifecycle output while retaining it
  for fallback diagnostics; verbosity can be adjusted with `BIVY_NPM_LOGLEVEL`.

## [0.16.1] - 2026-09-01

### Changed

- Documentation now distinguishes Bivy's local agent runtime, remote browser
  access, and optional hosted control plane more clearly.

### Fixed

- Native terminal handoffs now discover and resume agent sessions reliably,
  including Claude Code, Pi, Gemini CLI, and Qwen Code sessions.
- `bivy update` now recognizes scoped global npm installs and restarts an
  existing service even when its stored configuration hint is stale.
- Tool calls and results from agents that omit correlation IDs now remain paired
  in live and persisted transcripts instead of appearing as duplicate or
  indefinitely running tool cards.

## [0.16.0] - 2026-08-31

### Changed

- Control-plane and relay containers now run as an unprivileged user, drop Linux
  capabilities, prevent privilege escalation, and serve a host-scoped HSTS policy.
- Production dependencies were refreshed, including TypeBox, Highlight.js,
  Mermaid, PostgreSQL, Sentry, and cron-parser.

### Fixed

- Model-auth key requests no longer create a relay feedback loop, repeatedly
  write unchanged requests, or inadvertently trigger hosted machine provisioning.
- Scheduled automations now update PostgreSQL timestamp fields without parameter
  type-inference errors that caused due runs to retry indefinitely.

## [0.15.0] - 2026-08-31

### Added

- Self-hosted control planes can use AWS KMS as the hosted keyring source for
  encrypted machine enrollment credentials.
- Automation setup now includes source readiness checks, clearer trigger
  templates, scoped run history, and a dedicated Runs destination.
- Accounts can be permanently deleted from Accounts & Billing settings, including
  deployment-owned billing data, after any hosted machines are removed.

### Changed

- Installation now supports Node.js 20+, skips optional agent bridges and native
  terminal dependencies on the fast path, and installs only the selected agent
  integration when needed while preserving existing agent installs and logins.
- The PWA has a more focused mobile and desktop shell, simpler new-session and
  automation flows, improved workspace navigation, and more consistent sheets,
  menus, touch targets, and attention states.
- First-session onboarding now starts by connecting a machine, offers its default
  workspace without requiring GitHub, and limits the post-activation automation
  suggestion to a one-time next step.
- Add Machine now presents clearly labeled auto sign-in and regular sign-in
  commands with separate copy actions and explicit token-safety guidance.
- Maintained agent support is now reported separately from release-tested
  capability certification, so support status does not disappear when an
  upstream version moves beyond the latest certified range. Release-tested pins
  were refreshed for Claude Agent SDK 0.3.251, Codex 0.151.0, Pi 0.84.4, and
  OpenCode 1.18.25.
- The agent picker prioritizes Claude Code, Codex, Grok, OpenCode, and Pi while
  keeping the full catalog searchable, and uses an explicit confirmation when
  switching to an agent whose sign-in or protection level cannot be verified.
- Session and automation polling payloads are smaller to reduce routine control
  plane traffic.
- Direct GitHub queue runs now honor project and node rulesets for retries and
  fallback routing, matching hosted queue behavior.

### Fixed

- Session switching, closed-session resume, and async handoffs now keep prompts
  and follow-ups attached to the intended session and preserve native resume
  references; changing agents in a blank session remains a draft instead of
  creating an empty fork.
- Reasoning, structured tool calls, tool results, failures, and workspace changes
  are preserved consistently in stored and resumed transcripts.
- Webhook automations preserve signing settings, accept provider-native JSON
  payloads, and generate idempotency keys when providers cannot send custom
  headers.
- Signing out clears the account-bound browser device key and remote pairing, so
  the same browser can sign in and pair successfully with a different account.
- Concurrent automation and vault operations now share one device identity and
  tolerate stale recipients, avoiding save races and spurious sync failures.
- Token and claim-based machine installs now use the standard installer and a
  non-interactive enrollment path that works correctly on headless machines.
- Automations sidebar navigation and voice-provider key actions now open their
  intended destinations directly.
- Mobile overlays, modal history, Settings navigation, automation editor state,
  agent picker selection, actionable authentication errors, and terminal-launched
  updates no longer get stuck or lose user state; automation text fields also no
  longer trigger browser zoom on focus.

## [0.13.0] - 2026-08-27

### Added

- Hosted GitHub App support was extracted into the Cloud integration path.
- Personal machine claims and first-run onboarding now give new installs a
  clearer account-linked setup path.

### Changed

- Machine onboarding is more app-first, first-run launch messaging is sharper,
  Cloud machines are gated behind an explicit settings opt-in, and Free Cloud
  remote sessions now respect plan limits.

### Fixed

- Existing installs re-enroll with an account token so they stay connected after
  the account-linked onboarding changes.
- Blocked hosted automations now surface clearly instead of failing silently.

## [0.12.0] - 2026-08-27

### Changed

- One-off automations are hidden from the main overview so recurring automation
  management stays focused.
- Supported agent certification was refreshed for the latest Codex and OpenCode
  runtimes.

### Fixed

- Active web terminal sessions preserve their handoff path instead of dropping
  terminal continuity.
- Codex transcript repair keeps resumed conversations faithful after runtime
  certification updates.
- Revoked OAuth credentials are refreshed automatically instead of leaving
  connected integrations stuck until manual reconnect.

## [0.11.0] - 2026-08-19

### Added

- Machines can declare owner-asserted capability tags (`bivy config set
  node.capabilities '[gpu, docker]'`); repositories can declare required/
  preferred capability tags and named service health-check/start scripts in
  `.bivy/environment.yaml`. One-off Runs and Automation definitions can
  request required/preferred tags: a required tag honestly parks the Run
  (`needs_attention`) only when no Machine anywhere has ever declared it,
  and never fabricates availability for a preferred tag. CLI-only for now —
  see the capability-routing PR for the PWA-editing follow-up.
- `bivy run <agent> --chat` starts a governed session through the same runtime
  path as the web/PWA app and opens it directly; `--no-open` creates it without
  launching a browser and prints the session URL instead.
- Declarative agent plugins: `bivy plugin init|validate|doctor|test|install|list|remove`
  scaffolds and installs strict `bivy.sh/v1alpha1` manifests from local files.
  Plugins can contribute process or ACP agents to the CLI and web runtime catalog
  without a Bivy source change; executable code remains out of process and
  external rows are always Experimental / Unverified.
- Plugin developer tooling now includes the `@bivy/plugin-sdk` workspace package,
  a generated JSON Schema, `requires.bivy` semver compatibility enforcement,
  executable diagnostics, real ACP handshake conformance, and a runnable example.
- Packaged and node-configured agent integrations now share one ordered registry
  for provenance, aliases, visibility, discovery, connection, conflicts, and
  allowlisted upstream installation. Maintained profiles and Pi/Claude/Codex bridges
  live under `src/agents/` and connect to the operator's installed agent commands.
- `bivy agent add|list|remove` connects a user-owned ACP or headless process agent
  through the same strict manifest/store contract as installed plugin packages.
- Automations is now the **sole place** to connect, add, reconnect, or
  disconnect GitHub Apps, Linear, and Slack — full multi-app GitHub lifecycle
  (create, connect an existing app, install, reconnect a key on this machine,
  disconnect, default machine, who-can-trigger) lives in the Automations setup
  sheet. Settings → GitHub App / Linear / Slack are now thin hand-offs that open
  that same sheet instead of duplicating the flow.
- GitHub automations use structured **event rules** (`on[]`): one GitHub App,
  jobs pick which deliveries fire (issues/PRs labeled, @mentions on issue/PR/
  review comments, failed workflow runs). Outcomes are whatever the instructions
  say — not a special-cased PR path. UI collapses GitHub Actions into GitHub
  with event toggles; labels and @mentions work on PR surfaces too.

- Automations setup stays on the Automations surface end-to-end: outcome-first
  empty hero with featured jobs, whole-card templates with trigger badges, a
  single-page create sheet (name → trigger → instructions → machine), compact
  live source pills, and in-sheet GitHub / Linear / Slack connect so setup never
  dumps people into Settings. Success notices offer a clear next step (Run now /
  Open session); rows use overflow menus; webhook create still reveals the
  one-time signing secret.
- Forks into OpenCode now open on a full copy of the transcript instead of a
  seeded summary prompt: Bivy materialises the fork's conversation as a real
  session in OpenCode's own store (`$XDG_DATA_HOME/opencode/opencode.db`), so
  `session/load` resumes it and the model replays the whole history — the same
  "replayed" fidelity Codex's rollout forks get.
- Generic process integrations preserve native session identity across turns by
  capturing refs from validated structured output or using declarative
  host-assigned creation args (`resume.newArgs` in plugin manifests).
- Approval cards can now answer "Allow `git status` this session": approve and
  stop asking for the same program+subcommand (or the same tool, for edits)
  until the session closes. Rules live in the node's memory only and never
  reach the catastrophic floor, the backstop set (force-push, publish,
  deploy, `sudo`, …), risky integrations, a paused session, or a
  destructive-severity prompt — those keep asking every time.

### Changed

- The web app's status-bar / splash colors are now derived at build time from
  `--bg` in `packages/ui/tokens.css`, so a cold PWA load no longer paints a
  mismatched band before the theme applies.
- Stop stays reachable while the agent is working even after you start typing
  a follow-up; Send (queue) appears next to it instead of replacing it.
- Removed web components that had no entry point since earlier composer/menu
  simplifications (Inbox dialog, node stats panel, session settings, schedule
  sheet, run-task sheet) and their private CSS. The ☰ attention dot, session-list
  ranking, and the follow-up queue's scheduled rows are unchanged.

- Bivy Cloud billing, plan definitions, commercial metering, upgrade UI, and
  entitlement enforcement were removed from Core. The self-hostable control
  plane and relay now admit authenticated accounts without commercial limits;
  Cloud owns the complete commercial layer in its private repository.

### Fixed

- ACP integrations now distinguish already-running observed activity from
  permission-gated calls, confine filesystem client operations to the workspace
  with symlink-safe checks, approval-gate writes, enforce read-only mode, forward
  images and configured MCP servers, and fail explicitly instead of silently
  replacing a failed resume with an empty conversation.
- Custom `BIVY_CUSTOM_AGENTS` commands no longer inherit maintained agents'
  credential, session-store, discovery, or slash-command host behavior.
- The prebuilt ephemeral runner image (`ghcr.io/bivysh/bivy-ephemeral-runner`)
  is now actually published on every push to `main`. The workflow had failed at
  startup since it was added because it used `docker/*` actions the repository's
  Actions allowlist does not permit; it now drives the Docker CLI directly.

## [0.10.0] - 2026-08-07

### Added

- `BIVY_CUSTOM_AGENTS` registers named custom agents in both the web picker and
  `bivy run`: each entry extends a built-in CLI agent with an overrideable
  label, command, args, and parser, appearing as experimental/unverified while
  inheriting the base agent's execution behavior.
- Sessions keep a durable per-session changes history, openable at any time from
  a new session changes sheet, instead of only the current turn's changes card.

### Changed

- ACP (OpenCode) tool calls now surface structured tool names and real input
  detail (diffs, paths) as they stream, and turn history is persisted as ordered
  text/tool blocks exactly as they streamed instead of one merged block.
- First-run setup opens the self-hosted control plane when you pick self-hosted,
  and preserves your selected agent and node presence when handing off to the
  app.
- Bivy is now licensed under AGPL-3.0.

### Fixed

- Wedged sessions — a runtime that stops responding or stops emitting `agent_end`
  (opencode's ACP server, a frozen Pi) — are now force-recovered by a stall
  watchdog and a periodic sweep, and a new prompt to a hung session runs fresh
  instead of vanishing into the dead turn.
- Reasoning-log growth is bounded: a length-capped head with a truncation marker
  is persisted, so a stuck turn can no longer balloon the on-disk transcript.
- A flapping node no longer trips the relay's rate limiter and shows clients
  "Rate limit exceeded".
- Forks are portable across runtimes: resuming a fork restores the correct
  runtime and transport instead of clobbering the model and stream.
- Global npm install no longer bundles the Pi package, which broke the published
  `@bivy/bivy` install.

## [0.9.0] - 2026-08-06

### Added

- TUI-locked sessions now open into a dedicated handoff view with actions to
  attach the browser terminal or take the session back into chat. Chat sessions
  also expose a copyable `bivy resume <id>` command for continuing locally.

### Changed

- First-run setup is now agent-first: it detects and imports compatible Claude
  and Codex credentials into Bivy's encrypted vault, favors normal account
  sign-in, presents clearer choices, and hands users directly to their selected
  agent or the remote app. Missing-agent-auth errors now include actionable,
  agent-specific recovery steps.
- Hosted trial session locks are preserved across later node refreshes, and a
  newly opened client now receives the current terminal lock state immediately.

### Fixed

- The agent picker now stays aligned with the active session's runtime when the
  node's runtime list refreshes, while new-session drafts continue to use the
  selected default.
- Uninstalling an npm-global installation now removes its separate `~/.bivy`
  state directory. Tarball installs and `--keep-sessions` retain their existing
  state-preservation behavior.

### Security

- Removing a node now atomically rotates the model-credential sync key and wraps
  the replacement only for surviving nodes. Provider sign-outs propagate as
  encrypted, timestamped tombstones so stale credentials cannot be restored by
  another device.

## [0.8.2] - 2026-08-05

### Changed

- **Ephemeral machines are now opt-in and off by default.** The
  bring-your-own-cloud short-lived runners (Fly.io, Hetzner, AWS EC2) are a
  not-fully-developed Beta surface, so a deploy gets them only when it sets
  `EPHEMERAL_MACHINES_ENABLED=1` (web build: `VITE_EPHEMERAL_MACHINES_ENABLED=1`).
  This is fail-closed — production is off unless it explicitly opts in — while
  local `vite dev` keeps the surface on so development isn't gated. The flag gates
  all three layers: the web UI entry points, the control plane's server-initiated
  auto-provision (`planAutoProvision`), and the device-launch `/api/ephemeral/exec`
  relay. A machine's own idle self-teardown is intentionally unaffected, so any
  already-running machine still reaps itself.

### Fixed

- The PWA's status bar / browser-chrome color now matches the app background
  (`--bg`: `#f5f3ee` light, `#14171a` dark) instead of a pure white/black band —
  the static `theme-color` tags and `theme.ts` were still `#ffffff`/`#111111`.

## [0.8.0] - 2026-08-05

### Changed

- **Codex and OpenCode are now Supported-tier agents**, alongside Pi and Claude
  Code. Codex already cleared the bar on the app-server shim (per-tool
  Approve/Deny, model + reasoning-effort selection, thread resume, usage
  reporting, native session discovery) — the catalog just hadn't said so, and the
  support matrix wrongly listed its model picker as missing. Both now pin the
  exact CLI release they were certified against (Codex 0.145.0, OpenCode 1.18.13).
- **OpenCode runs over its native ACP server (`opencode acp`) by default**, which
  is what earns it the tier: per-tool Approve/Deny instead of effect-level
  sandbox governance only, plus `session/load` resume. Force the previous
  one-shot pipe path with `BIVY_OPENCODE_ACP=0`.

### Added

- ACP agents get **real model selection**: the shim reads the session's model
  config option, publishes it to Bivy as a post-`hello` `runtime.models` event,
  and applies a choice with `session/set_model` (falling back to
  `session/set_config_option`). The list comes from the live session, so it
  reflects the providers that node has actually authenticated rather than a
  hardcoded guess. Previously a promoted agent still advertised the pipe path's
  model picker while the shim silently ignored `model.set`.
- Default-on ACP promotion is **gated on a cached `--help` probe** for the
  agent's ACP subcommand. ACP has no mid-session fallback, so a node whose CLI is
  too old keeps the pipe path and honestly advertises the lower capabilities
  instead of opening a session that hangs and dies. `BIVY_<ID>_ACP=1` skips the
  probe; `=0` forces the pipe path.

### Fixed

- `bin/acp-shim.mjs` no longer hangs when the wrapped agent dies or never speaks
  ACP: in-flight JSON-RPC requests are rejected on child exit, `initialize` is
  bounded by a timeout, and the child's stdin has an error handler so an EPIPE
  reports the cause instead of crashing the shim. A non-ACP binary now fails in
  milliseconds with the real reason rather than timing out after 30s.
- The CLI capability help-probe cache is keyed by the resolved binary path rather
  than the bare command name, so upgrading or installing a CLI while the daemon
  is running no longer serves a stale capability answer.

## [0.7.0] - 2026-08-04

### Added

- Phase 7: connect-computer/credential-sync design doc + rotation-safe merge tiebreak (#344)
- Phase 6: per-session egress proxy/decider for workflow/sandbox network isolation (#343)
- Integrations as chat: Linear follow-up routing + provider-agnostic Case B (Phase 5) (#342)
- Phase 4: Codex/opencode slash commands + Codex TUI hand-off & usage (agents) (#341)
- Faster model switch: per-runtime scratch cache + client cache + prefetch (Phase 3) (#340)
- Fork reliability: fix 6 stand-up bugs + add integration coverage (Phase 2) (#339)
- Core-flow UX polish: attention list, queue auto-send, slash UI, update banner, terminal menu (#338)
- Remove local-CLI setup direction; complete Phases 0–2 (supersedes #333) (#334)

### Fixed

- Fix scrolling in expanded code changes card (#346)
- Fix Codex fork rollout metadata (#345)

## [0.6.0] - 2026-08-03

### Added

- **`attach_to_chat` reaches every agent, not just Claude/Pi** (#290). A new
  Bivy-owned MCP server, `bivy mcp-serve`, exposes the outbound-attachment
  capability as a first-class tool. It's auto-injected into a non-SDK agent's
  session-local JSON MCP config at session start (created when absent, restored
  on close), so codex/gemini/opencode/aider/… discover `attach_to_chat` in their
  own tool list instead of having to be told about a shell command. The tool
  POSTs to the same `POST /api/session/:id/attach` endpoint `bivy attach` uses.
  Injected into JSON MCP configs (claude/gemini/opencode/generic `.mcp.json`) and
  Codex's TOML (`~/.codex/config.toml`, `[mcp_servers.bivy]`). Claude and Pi keep
  their native in-process registration; tool-interception runtimes are skipped to
  avoid a duplicate. Goose YAML config is a follow-up.

- **Native `attach_to_chat` tool** for Claude and Pi sessions — the stronger,
  tool-based sibling of #297's discoverability hint. Claude sees it as a real
  MCP tool (an in-process server registered via the SDK's
  `createSdkMcpServer`/`tool`); Pi sees it through the same node-hosted
  `ToolProvider` mechanism connected integrations already use. Both call the
  same `attachToChat()` helper `bivy attach`/`POST /api/session/:id/attach` use,
  so a native tool call renders identically to the CLI path and goes through the
  same approval governance as any other tool call. No wiring needed per agent —
  the daemon threads one `attachToChat(sessionId, opts)` callback through both.

### Changed

- **Dependency updates** (batched Dependabot bumps). Production: `@anthropic-ai/claude-agent-sdk`
  0.3.199 → 0.3.220, and `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`
  0.82.1 → 0.83.0. Services: control-plane `stripe` 22.2.2 → 22.4.0; relay
  `@sentry/node` 10.67.0 → 10.69.0 (control-plane was already on 10.69.0). Tooling:
  `@types/node` → 26.1.2 and `tsx` → 4.23.1 in both services; transitive `postcss`
  → 8.5.25. CI actions: `actions/checkout` → v7.0.1, `actions/setup-node` → v7.0.0,
  `dorny/paths-filter` → v4.0.2.

### Security

- Bumped `fast-uri` → 3.1.5 and `ip-address` → 10.4.0 to clear their high-severity
  advisories in the production tree.
- The production audit gate now runs through `scripts/audit-prod.mjs` (wired into
  CI's `core` job as `npm run audit:prod`). It is `npm audit --omit=dev
  --audit-level=high` with a small, documented allowlist: it still fails on any
  high/critical advisory except the two `undici` advisories
  (GHSA-8xcm-r25x-g524, GHSA-4cwx-7wf7-3272) that are shrinkwrapped inside
  `@earendil-works/pi-coding-agent@0.83.0`, which no npm `override` or current
  upstream release can move. Scheduled for review by 2026-09-03; remove the
  allowlist entries once pi-coding-agent ships a patched `undici`.

## [0.5.0] - 2026-08-02

### Changed

- Agent-sent chat attachments now render **grouped under the turn's final
  assistant message** instead of as a standalone entry at the point `bivy attach`
  ran (which could strand a chip mid-turn, between tool cards and the reply). Both
  the live reducer and history replay attach the chip(s) to the final reply
  bubble — mirroring how the composer renders your own uploads under your message
  — falling back to a standalone entry only when a turn has no prose to hang them
  on. Client-only change (no wire/node change).

### Fixed

- Claude agents can now **discover** how to send a file/image to the user. The
  outbound attachment path (`bivy attach`) is a shell command with no tool, so
  the agent had no way to know it existed — "send me X as an attachment" was
  answered "I have no way to do that". The Claude Code system prompt now carries a
  short note teaching the agent to run `bivy attach <path> [--caption "…"]`, which
  pairs with the `BIVY_SESSION_ID` the node injects into the agent subprocess.

## [0.4.0] - 2026-08-01

### Added

- **Agents can now send attachments into the chat.** An agent surfaces a file it
  produced — an image renders inline as a thumbnail, anything else as a
  downloadable chip — via `bivy attach <file> [--caption "…"]`, the reverse of
  the composer paperclip. Works across runtimes (any agent that can run a shell
  command), reusing the existing content-addressed AttachmentStore, relay
  chunking, and rehydrate-by-hash rendering. The file is confined to the session
  workspace. Assistant messages now also render inline markdown images
  (`![alt](https://…)`, https-only). Backed by `POST /api/session/:id/attach`
  and a durable, position-anchored outbound-attachment projection in the event
  log so a reload or another device shows the attachment too.

## [0.3.0] - 2026-07-31

### Added

- Ephemeral machine configs are now first-class, routable **nodes**: they appear
  as selectable targets in the work-queue router and the new-session picker, and
  the control plane can **provision one unattended** when work arrives and no
  device is online — closing the device-offline path that previously required a
  signed-in device. Adds account-level `EphemeralNodeConfig` runner templates
  (provider/region/size/ttl/teardown), stored as JSONB on the account, with CRUD
  endpoints. (#276)
- The collapsed in-session run pill now shows the session's **PR badge** (open /
  merged / closed) when the session has a primary PR, matching the badge already
  rendered on the expanded run card — so you can see PR status without opening
  the card. (#277)

### Changed

- Polished the in-session run pill and its action sheet: the pill now reuses the
  sidebar `PrBadge` (GitHub mark + `PR`) instead of the wordy "Open PR" text,
  status labels drop the redundant "on node" ("Open on node" → **Open**,
  "Saved · not open on node" → **Saved**), and app sessions read **App** instead
  of "Session". (#278)
- Made the App-session sheet coherent — unified the GitHub link rows, aligned
  labels and icons, and added a repo link alongside the branch link — so the
  sheet reads as one system rather than a mix of idioms. (#279)

## [0.2.1] - 2026-07-31

### Added

- `bivy rename <name>` (alias `bivy node:rename`) renames the current node from
  the terminal, reusing the same local device-token auth as every other CLI
  command. The change takes effect immediately with no restart — the daemon
  persists it and live-updates relay presence and the `bivy/<node>` work-queue
  label. Previously renaming was only possible from the app UI. (#272)
- The in-session run card now shows a **"Forked from …"** marker when a session
  was forked from another, resolving the parent's name from the local session
  list (and degrading to a shortened id when the parent lives on another node or
  is gone). The sidebar row carries a matching **"Forked"** flag. (#270)

### Changed

- The in-session run card now appears for **every** session, not just
  automation-triggered ones, and carries the session's token/cost usage
  (previously a separate bar pinned under the top bar). Its detail sheet also
  surfaces the run's finished time, the routing/ruleset reason it was routed by,
  and the approval and sandbox policy it ran under. (#266)

### Fixed

- **Continue in chat** on a freshly-launched Pi or Codex run-terminal is now
  disabled until the agent has actually assigned its session, with a
  plain-language **"Send a message first"** caption, instead of enabling the
  button early and dumping a raw 409 error into the terminal. (#269)
- Edge-swiping to open the sidebar in the PWA no longer also triggers the
  browser's native back navigation. The gesture is now claimed on the first hint
  of horizontal intent, so `preventDefault()` fires while the system
  back/forward swipe is still cancelable. (#268)

## [0.2.0] - 2026-07-30

### Added

- GitHub App runs can now be restricted to contributors or collaborators only,
  via **Settings → GitHub App → Who can trigger runs**. Previously, anyone
  could `@`-mention the bot in an issue/comment on a public repository and
  queue a run; the new setting gates the mention trigger on GitHub's own
  `author_association` for the issue/comment author. Defaults to "everyone"
  (unchanged behavior). (#259)

## [0.1.2] - 2026-07-30

### Fixed

- Work queued for a node renamed while running is now picked up immediately; the
  hosted queue poller updates its `bivy/<node>` route without requiring a daemon
  restart. (#261)
- Git operations no longer fail with `Unable to read current working directory`
  after an npm update replaces the daemon's install directory. The daemon and its
  credential helper now anchor themselves in durable directories. (#261)

### Changed

- Settings now uses the official Slack and Linear logo geometry instead of
  approximate line-art icons. (#261)

## [0.1.1] - 2026-07-30

### Fixed

- Repository cloning now recovers when the daemon inherited a stale or deleted
  working directory. Clone destinations are resolved from a stable base, and the
  web client surfaces the self-healing retry instead of leaving the operation
  stuck on an opaque failure. (#256)

## [0.1.0] - 2026-07-30

First public release.

Bivy runs coding agent CLIs on machines you own and makes those sessions
reachable from a phone, browser, or another terminal. This release marks the
point at which the node daemon, CLI, relay, control plane, and web client are
published as source-available software.

### Highlights

- **Ten agents through one interface** — Pi, Claude Code, Codex, OpenCode,
  Gemini CLI, Qwen Code, Goose, Aider, Cline and Crush, each driven through its
  native CLI in a real PTY. Any other command runs via `bivy run -- ./your-agent`.
- **Durable sessions** — an append-only event log and a dedicated git worktree
  per session. Sessions survive detach, daemon restart, and reconnection from a
  different device.
- **Remote access without inbound ports** — the node dials out to a relay that
  forwards end-to-end encrypted frames. Device pairing uses X25519 + HKDF; the
  relay and control plane see ciphertext only.
- **Approvals** — risky shell commands and file edits pause for in-chat
  approval; safe read-only commands run automatically. Modes: `never`, `risky`,
  `always`, `autonomous`.
- **Session forking** — continue a session on a different agent, model, or
  machine, carrying the transcript and uncommitted work.
- **GitHub work queue** — label an issue `bivy` or mention the GitHub App, and a
  node you own claims it, works in an isolated worktree, and opens the PR.
  Multiple GitHub Apps per account are supported — one per personal account or
  organization, each with its own key and `@`-mention handle.
- **Terminal takeover** — `bivy shim install <agent>` makes the native TUI start
  inside a Bivy PTY, so an ordinary terminal session becomes remotely drivable.
- **Credentials stay local** — encrypted vault with `secret://`, `env://`, and
  `op://` (1Password) references resolved before the daemon starts.
- **Any model endpoint** — thirteen providers by API key or OAuth, plus
  self-hosted OpenAI-compatible, Azure, Ollama, LM Studio, vLLM and SGLang.
- **Bring-your-own-cloud runners** — short-lived machines on Fly.io, Hetzner, or
  AWS EC2 using a provider token that stays on your device.
- **Published on npm with provenance** — releases are published from CI via npm
  [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC, no
  long-lived token) and carry a signed provenance attestation; verify with
  `npm audit signatures`.

### Added

- **True cross-agent session forks.** Forking a session onto a *different* agent
  or model no longer drops the new agent into a 12-turn summary prompt. When the
  target runtime can import portable history (a new `forkHistoryImport`
  capability), the fork now materialises the *whole* transcript as real prior
  turns in the target's own store and resumes it — so a `pi → claude` (or
  model-swap) fork opens on an actual copy of the conversation, a third fidelity
  tier `"replayed"` between `"full"` (byte-exact same-runtime native replay) and
  `"seeded"` (the summary-prompt fallback). The replayed history is rendered as
  plain-text turns with tool activity inlined — never provider-specific
  `tool_use`/`tool_result` blocks — so it stays valid on any target model, and a
  runtime that can't import history (or an import that fails at run time) still
  falls back cleanly to the seeded continuation. Pi, Claude Code, and Codex all
  implement it (`AgentRuntime.importHistoryForFork`) — Codex by synthesising a
  resumable rollout under `$CODEX_HOME/sessions` (`writeCodexRollout`; best-effort
  against a live Codex resume, opt out with `BIVY_CODEX_NO_FORK_REPLAY=1`), wired
  through the shared `ProtocolRuntime.writeHistory` hook so any protocol/ACP agent
  with a writable store can opt in the same way. See `src/session/fork.ts` and
  `buildForkHistory` in `src/session/transcript-normal.ts`. The *source*
  side now works for **every** agent, not just those with a `readMessages` fast
  path: `buildForkBundle` falls back to the live session's transcript, so a fork
  *from* a wrapped CLI agent (which keeps its transcript only on the live
  session) carries its real history instead of an empty one — a true replay into
  pi/Claude/Codex, and a richer seeded prompt into any other target. The seeded
  fallback (for agents with no writable resume store) is now **budget-adaptive**
  rather than a fixed 12-turn tail: `buildSeedPrompt` packs verbatim recent turns
  up to a character budget (default ~3k tokens), so a long run of short turns
  carries far more context, while verbose turns stay bounded for the target's
  context window; anything that doesn't fit is reported as an omission count that
  points at the full transcript.

- **Ten more coding agents in the picker, and a general path to more capability.**
  The agent selector gains nine of the most-used CLIs — Cursor, GitHub Copilot,
  Grok, Amp, Auggie, Droid, Continue, Kilo Code, and Rovo Dev — plus a hidden
  Codebuff runtime (no verified non-TTY headless mode upstream yet). All are wired
  purely as data on the shared ProcessRuntime + CliParser path (resume/model
  advertised only where the CLI actually drives it), and the selector now sorts
  A→Z. Beyond breadth, five general levers push agents *up* the capability ladder
  without per-agent code: (1) a unified agent manifest — one `CLI_AGENT_SPECS`
  entry now drives the catalog, picker visibility (`hidden`), install
  (`cliInstallSpec`, shared with the server auto-installer), and the terminal CLI
  (`bin/agent-manifest.json`, sync-tested); (2) **MCP tool approvals**
  (`BIVY_MCP_PROXY`) — an agent's MCP `tools/call`s get real Approve/Deny via the
  same guardian path as native interception; (3) **tolerant structured parsers**
  (`generic-stream-json` / `generic-json`) that add transcript fidelity opt-in
  (`BIVY_AGENT_STRUCTURED=1`) and never lose output; (4) **capability probing**
  (`BIVY_AGENT_PROBE=1`) that runs `<cli> --help` and downgrades any resume/model
  capability the installed binary no longer evidences; and (5) a **general ACP
  adapter** (`bin/acp-shim.mjs`, runtime `acp`) that drives any Agent Client
  Protocol agent through the governed ProtocolRuntime for per-tool approvals,
  streaming, and resume — the preferred way to wrap agents that speak it, with
  per-agent promotion as data (Gemini CLI declares `acp` and promotes via
  `BIVY_GEMINI_ACP=1`; `BIVY_PREFER_ACP=1` promotes all ACP-capable agents,
  honestly gaining Approvals + Resume). See `docs/runtime-support-matrix.md` and
  `docs/agents/`.

- **Seven more agents promotable to the governed ACP path.** A systematic review
  of every supported agent for a native Agent Client Protocol server found seven
  beyond Gemini that ship one, and each now declares `acp` as data so it can be
  driven through `bin/acp-shim.mjs` → the governed `ProtocolRuntime` (per-tool
  Approve/Deny + `session/load` resume) instead of the one-shot pipe: **Qwen
  Code** (`--experimental-acp`/`--acp`), **OpenCode** (`acp`), **Goose** (`acp`),
  **Kilo Code** (`acp`), **Cursor** (`acp`), **Cline** (`--acp`), and **GitHub
  Copilot** (`--acp`). Promote one with `BIVY_<ID>_ACP=1`, or all at once with
  `BIVY_PREFER_ACP=1`; each stays off by default (on the honest pipe path) until
  validated for the installed version. Agents with no first-party ACP server
  (Aider, Amp, Crush, Continue, Grok) stay on the pipe — promoting them later is a
  one-line `acp` field, no runtime code.

- **Privacy-safe run evidence and outcome reports** — every automation run
  (GitHub issue/comment, Slack, manual, or scheduled) now carries a structured,
  allowlisted evidence record on top of its routing/status: why this node/
  runtime/model was chosen, declared-check pass/fail/exit status, and a
  capped, ordered event timeline (claimed, attempts, retries/fallback with a
  reason, branch, pull request, completion) — most of it stamped automatically
  by the control plane, with a node able to layer richer events on top through
  a new `POST /node/work/:id/evidence` endpoint. The GitHub queue view renders
  it as a per-run "Outcome reports" timeline with a **Copy sanitized report**
  export. The sanitizer (`services/control-plane/src/run-evidence.ts`) rejects
  prompt, transcript, diff, file-content, secret, token, and raw command/tool-
  output fields outright — no server-side transcript indexing, ever. GitHub
  issue/comment title and body are also no longer retained on the control
  plane at all: the claiming node now fetches them directly from GitHub,
  immediately before use. (#153)
- **Discover and adopt existing Claude Code / Codex sessions** — a node now
  advertises provider-native sessions its Claude Code or Codex adapters can
  see (a bare `claude`/`codex` run started outside Bivy), and the app can
  import one via a new "Import existing session" sheet, filterable by node,
  provider, repository, and recency. Discovery is capability-driven
  (`capabilities.nativeSessionDiscovery`/`nativeSessionAdoption`) and returns
  bounded metadata only — id/ref, cwd, updated time, a truncated first-prompt
  title, and an active/resumable flag — never transcript content, and never
  duplicates a session Bivy already manages. Importing resumes the session
  natively through the ordinary open/resume path without rewriting or
  deleting the provider's own history whenever the runtime supports it (the
  case for every Claude Code / Codex session today); a runtime that can only
  discover but not natively resume a session instead falls back to a fresh,
  seeded continuation — and the node refuses that fallback until the app
  shows the disclosure and the user explicitly confirms "Import anyway". A
  session with a live external process is never importable — Bivy has no safe
  way to take over a process it doesn't own — and instead surfaces the
  provider's own resume command (`claude --resume <id>` / `codex resume <id>`)
  so it can be followed read-only in a terminal. Other runtimes stay hidden
  from the discovery UI until their adapter earns the capability. (#156)

- **Scheduled automations** — Settings → Automations lets you create a
  recurring (cron, with an explicit IANA timezone) or one-time schedule that
  runs an end-to-end encrypted instruction template on an assigned node, with
  its own runtime/model/approval/sandbox defaults, run-now, enable/disable,
  next-run preview, and recent results. Schedules generate runs through the
  same automation-run lifecycle as GitHub/Slack/manual triggers — an offline
  node's due occurrence stays pending until it reconnects, restarting the
  control plane or running several instances can't duplicate an occurrence,
  and hosted entitlement checks happen at run admission, not schedule
  creation. The control plane only ever holds routing metadata plus the
  ciphertext; it cannot read the instructions. (#148)

- **GitHub App key sync across nodes** — `bivy github:app-sync on` opts a node
  into pulling/pushing a connected GitHub App's private key E2E-encrypted
  through the control plane, so connecting an app on one node makes it usable
  on the account's other opted-in nodes without re-uploading the `.pem`. Off
  by default and per node; the control plane never holds a plaintext key.
  Removing a node from the account flags its apps for rotation, so a
  surviving node mints a fresh vault key on its next sync. (#88)

### Changed

- **Free interactive sessions are now unlimited; Pro meters the operations layer.**
  The free rolling allowance now counts only unattended GitHub, Slack, webhook,
  and scheduled jobs. CLI, phone, browser, and interactive ephemeral-runner
  sessions no longer consume it. Free includes 10 automations per rolling seven
  days; Pro keeps automation unlimited. This aligns pricing with the product's
  differentiated queue rather than charging for basic remote control.
- **Automations panel: node selector instead of free text, plus an ephemeral
  fallback toggle** — the generic webhook automations panel's "Default node"
  field used to be a plain text box you had to type a node's label into
  correctly, unlike the GitHub App panel's dropdown of known nodes; it's now
  the same dropdown (falling back to text only when the account has no known
  nodes yet), for both creating a webhook and editing an existing one's
  routing. The account-wide "auto-provision an ephemeral server when nothing's
  online" toggle — previously only visible in GitHub App settings — is also
  now shown here, since the shared automation-run queue already picks up
  webhook-triggered work the same way it picks up GitHub work. (#166)
- **Nodes settings panel: fields grouped into labeled sections** — the panel
  used to list a dozen unrelated fields (node name, default agent/model,
  sandbox mode, GitHub session limit, GitHub issue prompt, session sync) as
  one continuous flat list with no visual separation, which read as a wall of
  text, especially in the mobile drill-in view. Fields are now grouped under
  labeled sections (Node, Identity, Session defaults, GitHub, Session sync)
  with divider lines between them, matching the grouping already used by the
  GitHub App and GitHub Queue panels. (#74)

### Security

- Updated the bundled Pi runtime to 0.82.1 and pinned patched MCP/Hono
  transitive releases, clearing the protobuf and MCP HTTP-server advisories from
  the release tree. One upstream `brace-expansion` advisory remains
  inside Pi's published shrinkwrap and is tracked pending an upstream package release.
- The node no longer authorizes bare loopback callers (no token) by default on
  a host it detects as multi-user — every local account shares `127.0.0.1`, so
  loopback alone let any other OS user on a shared host drive the agent (shell
  + file edits) without a token. Detection (`isMultiUserHost` in `src/auth.ts`)
  counts real login accounts via `/etc/passwd` on Linux or `dscl` on macOS;
  single-user hosts (the common case) keep today's zero-friction loopback
  bypass unchanged. Override with `BIVY_REQUIRE_LOCAL_AUTH=1`/`=0` or
  `BIVY_MULTI_USER_HOST=1`/`=0` if detection guesses wrong for your box. The
  CLI transparently bootstraps a device token when the daemon requires one, so
  `bivy status`/`bivy doctor`/etc. keep working unchanged. (#111)

### Fixed

- **Multiple nodes on one machine no longer collide on port 4317.** Running a
  second node on the same box — a staging + production node, or one node per OS
  user — used to fail: `bivy setup` always defaulted the local port to `4317`,
  never checked whether it was free, and even ignored `PORT=… bivy setup`
  (it only read `cli.json`). The loopback address `127.0.0.1:4317` is
  machine-wide, not per-user, so whichever node started second failed to bind —
  and worse, the daemon's catch-all `uncaughtException` net swallowed the
  `EADDRINUSE`, leaving a process that was "running" but listening on nothing.
  Setup now auto-selects the first free port at or above `4317`
  (`bin/port-picker.mjs`), so additional nodes land on `4318`, `4319`, …
  automatically; an explicit `PORT` is still honored verbatim. And the daemon now
  fails loudly on a taken port with an actionable message instead of wedging
  silently.

- **Port-collision detection now also covers install, restart, and update — not
  just `bivy setup`.** The auto-avoidance above only ran during `bivy setup`;
  `bivy service install`, `bivy restart`, and `bivy update` baked the *saved*
  `cli.json` port into the systemd/launchd unit (and restarted into it) verbatim.
  So a node whose `4317` had since been claimed by a second node on the same box
  — e.g. a root install plus a per-user install, or a second OS user who ran
  setup while the first node was down — would keep colliding across every restart
  and update, with no re-check. These paths now re-validate the port right before
  writing the unit / restarting: a free port is kept, a port still held by *this
  install's own* node is kept (a plain restart never relocates a node off the port
  it already owns — the occupant is identified by comparing its `/api/status`
  `appDir` to ours), and a port taken by a *foreign* node rolls forward to the
  next free one, is persisted to `cli.json`, and the unit is rewritten to match.
  An explicit `PORT` is still honored verbatim. New pure helper `reconcilePort`
  in `bin/port-picker.mjs`, unit-tested alongside `findAvailablePort`. (Detecting
  a *stopped* peer's pinned port still isn't possible from a live socket probe —
  that would need reading another user's `cli.json`, which a per-user install
  can't do — so give distinct installs distinct ports up front if they may be
  down at install time.)

- **OpenCode runs fail loudly, not opaquely, when a provider key is missing.**
  `opencode run` boots OpenCode's own server, which returns an opaque
  `UnknownError: Unexpected server error. Check server logs for details.`
  (with an `err_…` ref pointing at a log Bivy can't read) when the selected
  provider has no credential — so a user with, say, GPT-5 selected but no
  OpenAI key just saw a cryptic 500. A provider-aware credential preflight
  (`src/runtime/opencode-preflight.ts`, mirroring the Codex one) now catches the
  missing key up front and returns an actionable message naming the provider and
  the env var to set. Bivy also strips ANSI escape codes from relayed CLI output
  (`src/runtime/ansi.ts`), so dumb-pipe agents no longer render their colorized
  errors as `[91m[1m…` garbage in the agent-output pane. (#205)
- **Ephemeral machines now actually come online.** The bootstrap installed
  Bivy but never *started* the node on a headless, pre-enrolled machine (no TTY
  → the installer just prints "run `bivy setup`"), so the node never dialed the
  relay and stayed offline. The bootstrap now writes `/etc/bivy/start.sh` and
  launches the daemon (`bivy start`, reading the baked `relay.json`) — via a
  transient `systemd-run` unit on VM providers (Hetzner/EC2). **Fly.io was doubly
  broken:** a Fly Machine is an OCI image in a microVM, not a cloud-init VM, so
  the `#cloud-config` user-data was never executed and the bare `ubuntu:24.04`
  ran `/bin/bash`, which exits instantly — with `restart: no` + `auto_destroy`
  the machine self-destructed on boot ("this app has no machines" / node
  offline). Fly now boots from machine `files` + a **foreground** init process
  that installs `curl` (absent from the bare image) and Bivy, then runs the
  daemon under a TTL `timeout`. Also added an official-nodejs.org Node 22
  fallback to `install.sh` since `deb.nodesource.com/setup_22.x` now returns
  `403` (apt otherwise falls back to Node 18, which is too old for Bivy).
  Launching also self-heals the fallout from the above: every self-destructed
  machine left an orphaned `eph-*` node enrolled on the account, and enough of
  them tripped the plan's node limit so new launches failed enrollment with a
  generic "Could not enroll the machine". A node-limit-blocked launch now reaps
  its own orphaned ephemeral nodes (offline `eph-*` nodes past their boot grace,
  never a persistent or still-booting node) — and drops any lingering local
  "Launched machines" row for them — then retries.
- **Transient CLI/relay clients no longer clutter "Signed-in devices".**
  `bivy run --node` bridges and sibling-node replicas paired with a node via
  the same `pair.account` handshake a phone/browser uses, so the control plane
  recorded each one as a durable paired device. Because these tools can mint a
  fresh device keypair per invocation (probes, tests, one-off runs), the
  account's Account & billing → Signed-in devices list filled up with rows
  like "Bivy CLI probe" and "Bivy CLI (run --node)" that never got cleaned up.
  These transient connections now mark their pairing `ephemeral`: the node
  still authorizes them and hands over the room key, but the control plane
  skips the paired-device record, so only real user devices are listed (and
  the account's device count stays accurate). Genuine app/QR devices are
  unaffected.
- The GitHub issue queue's per-node concurrency cap now actually lets issues
  run in parallel up to the configured limit. `GitHubTaskPoller` (and the
  hosted work-queue's `ControlPlaneTaskPoller`) used to `await` each claimed
  issue/item to completion before even considering the next one in the same
  poll tick, so — regardless of the concurrency setting — only one ran at a
  time; the cap only ever appeared to do anything when two `setInterval` ticks
  happened to overlap by luck. Issues/items now start concurrently (still
  capped) within a single tick. (#116)
- `bivy relay:setup` now honors `BIVY_DATA_DIR` like every other entry point
  instead of hardcoding `<repoRoot>/.bivy`. On a global/packaged install
  (where the CLI resolves the data dir to `~/.bivy`) it used to write
  `relay.json` and the node identity into the install directory, which is
  wiped on update, silently breaking remote access after `bivy update`. (#2)
- The sidebar no longer drops another node's `bivy run` terminals when you
  switch nodes — e.g. from the "New session" header switcher. Run terminals
  are now tagged and merged by node the same way chat sessions already were,
  so the sidebar keeps showing every node's sessions regardless of which node
  is currently selected. (#99)
- `bivy sessions` / `bivy ls` now lists every saved session by default instead
  of only the 15 most recent, so older sessions are visible and resumable
  again. Use `--limit`/`--n` to cap the list. (#71)
- `install.sh` now persists a PATH fix into `~/.bashrc`/`~/.zshrc` when the
  npm (or fallback `~/.local`) bin directory isn't already on `PATH`, instead
  of only printing an `export PATH=...` line — which fixed nothing beyond the
  terminal that ran the installer, leaving `bivy` unrecognized in every new
  shell afterwards. Opt out with `BIVY_NO_RC_UPDATE=1`. (#69)

### Known limitations

- Bivy does not ship an OS-level sandbox jail. Sandbox tiers are enforced
  natively by agents that support them; others are governed at the filesystem,
  MCP, and network layer.
- Queued GitHub issue titles and bodies are stored in plaintext by the control
  plane until a node claims them.
- Credential sync between your own nodes covers Bivy-managed provider keys;
  agent-native logins remain per-machine.
- Aider and Crush cannot resume a session (upstream gaps).
- Self-hosting is unsupported: no SLA, community best-effort.

For the complete trust model and the full list of 0.1 limitations, see
[`docs/security-model.md`](docs/security-model.md).