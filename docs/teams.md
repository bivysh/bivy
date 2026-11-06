# Teams

A team is a named group of Bivy accounts. Open **Settings → Team** to start
one, invite people and manage roles.

## Roles

| Role | Can |
|---|---|
| Admin | Rename or delete the team, invite people, change roles, remove members |
| Member | See who is in the team, leave it |

The person who starts a team is its first admin. A team always keeps at least
one admin: the last admin can't step down or leave while others remain. If the
last admin's account is deleted, the longest-serving member becomes admin. When
the last member leaves, the team is deleted.

An account is in at most one team.

## Invites

- **Email invite:** works once, only for that address. Bivy emails the link
  when the server has an email sender (`RESEND_API_KEY` + `AUTH_EMAIL_FROM`);
  otherwise the panel shows the link to send yourself.
- **Invite link:** works for up to 25 people for 7 days. Anyone signed in who
  has it can join, so share it only where you'd share the team.

Admins can revoke an open invite at any time. The token is in the link's
fragment (`/team/join#tin_…`), which browsers never send to a server, so it
does not appear in access logs. The control plane stores only its hash.

## Team instructions

Admins write instructions in **Settings → Team → Team instructions**. Every
agent session on every member's machines gets them, after Bivy's own note
and ahead of each person's account-wide instructions. Where they conflict,
the person's own instructions and the repository's AGENTS.md or CLAUDE.md
win. Members see them read-only. The limit is 16 KB.

They are end-to-end encrypted with a team key that only members' machines
hold:

1. The admin's machine encrypts the instructions under the team key and
   uploads the ciphertext.
2. A member's machine that doesn't have the key asks for it. Any team
   machine that holds it seals it for the asker under an X25519 key the two
   machines share (`team-vault` wrap purpose), so the control plane passes it
   on without being able to open it. Machines check every minute, and
   sooner on a relay wake.
3. When someone leaves the team, or a machine that held the key is removed,
   the vault is flagged. An admin's machine then re-encrypts under a fresh
   key, which only the remaining machines get. A machine whose account
   leaves deletes its copy of the instructions and the key.

Edits go through whichever machine the editor is connected to. A save names
the version it started from, so two admins can't silently overwrite each
other.

On a machine, the opened instructions are kept in
`<data dir>/team-instructions.json` and the key in `team-vault.json`
(mode 0600).

## Shared machines

The owner of a machine can share it with their team: connect to it, open
**Settings → Machines**, and turn on **Share with team**. The machine then
shows up for every teammate under **Shared with you** in the machine menu,
labeled with the owner's email, and they connect to it as to their own.

A teammate on a shared machine has what the owner has there: sessions,
terminals, files, and the agent sign-ins and keys on that machine. That is
what holding a machine's room key means. Bivy has no read-only or per-session
access yet. Usage on the machine counts as the owner's, including waking a
sleeping cloud computer.

- **The machine decides.** The switch is stored on the machine. While it is
  off, the machine refuses a teammate's device even when the control plane
  vouches for it, so the control plane alone can't open a machine to anyone.
- **Leaving ends access.** When a teammate leaves the team, the control plane
  stops issuing them pair grants and relay tickets for the machine at once.
  Within a minute, the machine removes their devices and rotates its room key,
  as when you remove a device by hand.
- **Sign-ins stay with the machine.** If a teammate signs in to Claude,
  ChatGPT or another provider while connected to your shared machine, that
  sign-in is stored on your machine, and you and the rest of the team can use
  it there. The sign-in card says so on a teammate's machine. Sign in on a
  machine of your own for anything you want to keep to yourself.
- **Turning sharing off** removes every teammate device from the machine and
  rotates its room key. The owner can also remove one teammate's devices from
  the list under the switch.

Under the hood, a teammate's relay ticket names the owner's account and is
pinned to that one machine. The relay doesn't change: it still admits only
devices with the room's account.

Sessions a teammate starts on a shared machine show "By <their email>" in the
session list. The machine takes the email from its own record of the device
that sent the request, so it is attribution, not a security boundary: anyone
on the machine has the same access.

## What the control plane holds

The roster: team name, members' account ids and emails, roles and open
invites. For team instructions, it holds only ciphertext and copies of the
team key sealed for each machine. It can't read either. A team doesn't give
anyone access to another member's machines, sessions or keys, and admins
can't read members' sessions.

The control plane decides which machines count as team machines. A
compromised control plane could claim that a machine it controls belongs to
the team and receive the key, just as account pairing trusts it to vouch for
devices (see [the security model](security-model.md#account-pairing-the-control-plane-vouches-for-the-device)).

## Deployment hooks

A deployment with a policy service (`DEPLOYMENT_EXTENSION_URL`) is asked
before:

| Operation | Context |
|---|---|
| `team.create` | `teamMembers: 1` |
| `team.member.add` (an invite is accepted) | `teamId`, `teamMembers` (size once admitted) |

A refusal is shown to the person with the service's reason and any actions it
returns. After every roster change the service also receives a
`team.members-changed` event with `teamId` and the new `members` count (0 once
the team is gone). With no policy service, teams are free and unlimited.

## API

All routes need a signed-in account (`Authorization: Bearer <session>`).

| Route | Who |
|---|---|
| `GET /account/team` | anyone: your team, members, and open invites (admins) |
| `POST /account/team` `{ name }` | anyone not in a team |
| `PATCH /account/team` `{ name }` | admin |
| `DELETE /account/team` | admin |
| `POST /account/team/invites` `{ email?, role?, maxUses?, ttlMs? }` | admin |
| `DELETE /account/team/invites/:id` | admin |
| `PATCH /account/team/members/:accountId` `{ role }` | admin |
| `DELETE /account/team/members/:accountId` | admin, or yourself to leave |
| `POST /account/team/invite-preview` `{ token }` | anyone |
| `POST /account/team/join` `{ token }` | anyone |

A machine reports its switch with `PUT /node/team-share` `{ shared }` and reads
`GET /node/team-share` (whether it is shared, and the team's current member
accounts). Machines use `GET`/`PUT /node/team-vault`, `POST /node/team-vault/key-request`
and `PUT /node/team-vault/key` with their enrollment token. Only admins'
machines may `PUT /node/team-vault`.
