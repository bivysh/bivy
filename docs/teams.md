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

## What the control plane holds

Only the roster: team name, members' account ids and emails, roles and open
invites. A team doesn't give anyone access to another member's machines,
sessions or keys. Admins can't read members' sessions either.

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
