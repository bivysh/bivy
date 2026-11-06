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

Machines use `GET`/`PUT /node/team-vault`, `POST /node/team-vault/key-request`
and `PUT /node/team-vault/key` with their enrollment token. Only admins'
machines may `PUT /node/team-vault`.
