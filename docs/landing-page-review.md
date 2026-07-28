# Landing page review

Reviewed: 2026-07-28

## Executive summary

Bivy has a credible, differentiated product: a control and automation layer for coding agents that executes on infrastructure the customer controls. The previous landing page contained the right facts, but made visitors assemble that positioning from an 88 KB, 1,600-line feature catalogue. It led with infrastructure language, offered two competing first actions, delayed product proof, and treated unlike competitors as one uniformly weak category.

The revised page leads with the job users hire Bivy to do — turn incoming work into pull requests — then explains the own-infrastructure difference. It makes install the primary activation path, brings real product screenshots into the first screen, groups features around outcomes, keeps security claims precise, and moves implementation detail to documentation.

## Who the page should convert

### Primary: agent-heavy individual developers and small teams

They already use Claude Code, Codex, Cursor, or another CLI and want to delegate more work without babysitting terminals. Their needs are:

- start work from GitHub or another system rather than from a terminal;
- use the repositories, dependencies, credentials, and private network already on their machines;
- see whether a run is working, intervene when it is not, and get a reviewable result;
- avoid being forced into one agent, model, sandbox, or metered compute provider;
- keep spend predictable while paying model and infrastructure providers directly.

Their willingness to pay starts when Bivy reliably performs unattended work. The $15 Pro boundary is therefore better attached to unlimited automation than to interactive sessions. Interactive use is the product-led acquisition loop; durable unattended throughput is the monetizable outcome.

### Secondary: platform and engineering leads

They care about routing, policy, evidence, shared operation, and data boundaries more than a mobile terminal. They may pay materially more, but the current Team offer is a design-partner motion rather than a finished enterprise SKU. The page should invite that conversation without presenting planned SSO or audit features as generally available.

### Poor-fit visitors to disqualify

Bivy is not the simplest choice for someone who wants bundled inference and zero infrastructure, or who only uses one vendor and is satisfied with that vendor's remote/cloud agent. Saying this clearly builds trust and reduces low-quality activation.

## Problems found in the previous page

### Positioning and copy

1. **Infrastructure before outcome.** “Route coding-agent work to infrastructure you own” accurately described the mechanism, but not the result users want. GitHub issue → reviewed PR is more concrete and valuable.
2. **Too many products at once.** The page alternated among queue, mobile remote, terminal, rules engine, security architecture, credential sync, ephemeral compute, and self-hosting. The reader had no clear hierarchy.
3. **Feature count substituted for confidence.** “19 agents” appeared repeatedly even though the support matrix has two Supported integrations and many Beta integrations with different capabilities. The count is useful breadth proof, but capability honesty matters more.
4. **The paid value arrived late.** Pricing correctly charged for automation, but most of the page still described sessions. The revised story makes reliable unattended operation the core value and interactive control the supporting advantage.
5. **Aspirational and live capabilities blurred.** Team features and some automation language read as shipped commitments. The revised Team card explicitly says the offer is being shaped with design partners.
6. **Security language needed a complete sentence.** “Your code never uploaded” could be read as “code never leaves the machine,” although the chosen model provider receives whatever its agent sends. The revised page distinguishes Bivy's boundary from the model provider's.

### UX and conversion

1. **No visual proof above the fold.** The first screenshot appeared after the competitive table and a long flow diagram. The revised hero shows the real session UI immediately.
2. **Competing primary actions.** “Start free” opened the app, while the install command was the actual prerequisite and setup path. Install/quickstart is now the clear first action; app sign-in is secondary navigation.
3. **Excessive length and repetition.** The old page was approximately 88 KB and repeated agents, security, pricing, and workflow in multiple sections. Technical depth belongs in linked docs and the comparison page.
4. **Navigation reflected internals.** Links such as Rulesets and How it works competed with the user journey. The revised navigation follows Product → Security → Pricing → Docs.
5. **Mobile navigation overflowed.** Hiding selected links still left a crowded header. The revised mobile header keeps only Docs, Sign in, and Get started.
6. **The install control looked like code but was not the obvious CTA.** It now has an explicit copy button, a nearby five-minute quickstart, and copy feedback announced to assistive technology.

## Competitive landscape

The useful comparison is not “Bivy versus all cloud agents.” There are three alternatives:

1. **Vendor-hosted coding-agent queues** (for example Cursor background agents, GitHub Copilot coding agent, Codex cloud, Jules, and Devin). Their advantage is low setup and bundled managed execution. Bivy's advantage is execution location, agent choice, existing toolchain/network access, direct provider billing, and self-hostability.
2. **First-party remote controls.** These are usually the best experience for one vendor's agent. Bivy is compelling when a user needs a mixed-agent fleet, one queue, cross-device control, or policy across providers.
3. **SSH/tmux/VPN and scripts.** These are flexible and often free. Bivy should not claim to replace the shell; it adds structured sessions, mobile diffs and approvals, notifications, queue routing, retries, and outcome records.

The prior comparison table overstated the category with claims such as every hosted queue having one pool, manual-only retry, and per-seat plus usage pricing. Competitors vary and change quickly. The revised table compares durable architectural choices and explicitly gives managed cloud queues credit for zero setup and bundled compute.

## Message hierarchy implemented

1. **Outcome:** turn issues and requests into pull requests.
2. **Differentiator:** run on the customer's machines, with their agents and credentials.
3. **Proof:** real app and CLI screenshots, a four-step workflow, and supported-agent breadth with a link to the capability matrix.
4. **Reasons to pay:** unattended queue, recovery policies, and outcome visibility.
5. **Trust:** exact data boundary, honest limitations, source availability, and explicit poor-fit guidance.
6. **Offer:** unlimited interactive use free; unlimited automation at $15/month; design-partner Team conversation.

## Implementation decisions

- Replaced the long feature catalogue with a focused static page and no new dependencies.
- Promoted the install/quickstart path over an app-only signup path.
- Added responsive hero proof using existing repository screenshots.
- Rewrote competitive copy to compare trade-offs rather than use blanket negative claims.
- Consolidated security into a concise boundary table and linked the full security model.
- Kept exact requirements and 0.x limitations near the conversion point.
- Preserved Plausible CTA and install-copy events without sending user or session data.
- Added reduced-motion support, visible focus states, semantic headings, an accessible comparison table, and an ARIA live copy status.

## Follow-up measurement

Plausible should be used to compare these fixed-name events:

- `Install Copy` at hero and footer;
- `CTA` placements for quickstart, GitHub, pricing, Pro upgrade, and Team contact;
- downstream activation: setup completed, first model authenticated, first session started, first automation connected, and first automation succeeded.

The most important funnel is not page → account. It is page → install copied → node enrolled → first successful interactive run → automation connected → first successful unattended PR → Pro upgrade. If install copies rise but successful first runs do not, improve setup rather than adding more landing-page copy.
