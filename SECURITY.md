# Security Policy

Bivy runs coding agents on machines you own, with your credentials and your
source code. We take reports seriously and we would rather hear about a problem
early than read about it later.

For how Bivy is designed — trust boundaries, encryption, the approval gate, and
its known limitations — see [`docs/security-model.md`](docs/security-model.md).

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No |

Bivy 0.1 is an early public release. Fixes ship on the latest 0.1.x patch; there
are no backports to older builds. Always report against the newest release.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

**Primary channel — GitHub private vulnerability reporting:**
https://github.com/bivysh/bivy/security/advisories/new

This is preferred. It gives us a private thread with you, a CVE if one is
warranted, and a clean path to a coordinated advisory.

**Backup channel:** `support@bivy.sh` (mark the subject "SECURITY" and we will
move it to a private thread)

Please include:

- what you found and why it matters;
- the affected component and version (`bivy --version`), plus OS;
- reproduction steps, or a proof of concept;
- what an attacker gains.

If you cannot reach us through either channel, open a public issue that says
only "I have a security report and need a private channel" — with no details.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | 3 business days |
| Initial assessment (valid / not, rough severity) | 7 business days |
| Fix or documented mitigation for a confirmed high-severity issue | 30 days |
| Fix for lower-severity issues | Next scheduled release |

Bivy is a small project. If we slip, we will tell you where things stand rather
than go quiet.

## Disclosure policy

We follow coordinated disclosure.

- Please give us 90 days from acknowledgement before disclosing publicly.
- We will keep you updated and tell you when a fix ships.
- We will publish an advisory when a fix is released, and credit you by the name
  or handle you choose — or leave you anonymous if you prefer.
- If a vulnerability is being actively exploited, we will move faster and may
  publish before a full fix, with mitigation guidance.

## Scope

### In scope

- The node daemon (`bivy` / `bivyd`) and its local HTTP/WebSocket API.
- The `bivy` CLI.
- The relay (`services/relay`).
- The control plane (`services/control-plane`) and the hosted service at
  `bivy.sh`.
- The web client and PWA.
- The pairing, end-to-end encryption, and device-token code paths.
- The approval gate and the tool-call guard, where a bypass grants execution the
  user did not authorize.
- Release artifacts and the signing/verification chain.

### Out of scope

- Misconfiguration of a self-hosted deployment — weak or shared `RELAY_SECRET`,
  a database exposed to the internet, missing TLS in front of the relay, running
  the daemon as root or on a shared host without
  `BIVY_REQUIRE_LOCAL_AUTH=1`.
- Behaviour behind a documented, explicitly opt-in escape hatch:
  `BIVY_ALLOW_ANY_ORIGIN=1`, `BIVY_OPEN_BOOTSTRAP=1`, `approvalMode: never`,
  or the `danger-full-access` sandbox tier. These are documented as unsafe;
  reporting that they are unsafe is not a vulnerability.
- The limitations already documented in
  [`docs/security-model.md`](docs/security-model.md#known-limitations-for-01) —
  most importantly, that Bivy provides no OS-level sandbox of its own. A report
  that an agent without a native sandbox can act as your user is a known design
  limit, not a finding. A report that a *native* sandbox tier can be escaped
  through Bivy's mapping is in scope.
- Vulnerabilities in third-party agents (Claude Code, Codex, Gemini CLI, Goose,
  Aider, …) or in the models themselves. Report those upstream. Bivy's
  *integration* with them is in scope.
- Social engineering of maintainers, users, or infrastructure providers.
- Physical attacks, or attacks requiring an already-compromised machine or an
  already-compromised account.
- Denial of service through volumetric traffic, and rate-limit tuning.
- Automated scanner output with no demonstrated impact, missing security headers
  on static pages, SPF/DMARC opinions, and reports whose only content is a
  version banner.

## Safe harbour

If you make a good-faith effort to follow this policy, we will not pursue or
support legal action against you for your research, and we will treat your
activity as authorized under applicable anti-hacking law and the terms of
service for our hosted services.

Good faith means:

- test only against your own accounts, nodes, and data, or a self-hosted
  deployment you control;
- do not access, modify, or retain data belonging to anyone else — if you
  encounter it, stop and tell us;
- do not degrade service for other users; no volumetric or destructive testing
  against hosted infrastructure;
- report promptly, and give us reasonable time to fix before disclosing.

If a third party brings legal action against you and you have followed this
policy, we will make that clear.

This policy does not authorize action against third-party services Bivy
integrates with; their own policies apply.

## Security principles

- The node is the data plane. Your code, credentials, and transcripts stay
  there.
- The control plane stores account and routing metadata, not session content.
- Session traffic crossing the relay is end-to-end encrypted; the relay routes
  ciphertext it cannot read.
- Production deployments must use strong, unshared secrets and durable storage.
- We would rather document a limitation honestly than imply a guarantee we
  cannot make.
