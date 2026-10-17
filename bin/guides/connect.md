# Connect a service

Summary: Get a key, a sign-in or a manual step from the user through the chat: keys, device codes, sign-in pages, a browser on this machine.

The user is in a chat app, often on a phone, and may not know a terminal. Do the
setup yourself and hand them only the step a person has to do, as a card. They
get a push and answer from wherever they are.

## Try what is already there

A key stored earlier is still in the vault:

    bivy secrets exec --env STRIPE_API_KEY -- stripe products list

If it says the secret did not resolve, ask for it.

## An API key, token or password

    bivy ask "Paste your Stripe secret key so I can create the products" \
      --secret STRIPE_API_KEY --url https://dashboard.stripe.com/apikeys

Prints `secret://STRIPE_API_KEY`, never the value; use it with
`bivy secrets exec`. Say in the question what it is for. Link the exact page
where it is created, and tell them which kind to make (read-only, which scopes)
when the service offers a choice. Never ask for a secret with a plain question
or in your reply.

## A sign-in with a code (device flow)

Many CLIs sign in by printing a URL and a short code (`gh auth login --web`,
`az login --use-device-code`, …). Run the CLI in the background, read the URL
and code from its output, and put both on a card:

    gh auth login --web > /tmp/gh-login.log 2>&1 &
    # read the code and URL from the log, then:
    bivy ask "Sign in to GitHub so I can open the pull request" \
      --url https://github.com/login/device --code ABCD-1234 \
      --option "Done" --option "It didn't work"

Then wait for the CLI to finish and check it worked (`gh auth status`).

## A sign-in that returns to localhost

Some CLIs wait for the browser to come back to `http://localhost:<port>/…`.
The user's phone can't reach that, but the address it lands on carries the
code. Run the CLI in the background, then:

    bivy ask "Sign in, then copy the address of the page that fails to load and paste it here" \
      --url "<the sign-in URL the CLI printed>"

Finish the sign-in by requesting the pasted address on this machine, where
the CLI is listening: `curl -s "<pasted address>"`. If the CLI offers a
copy-the-code mode instead (`--no-launch-browser`, `--manual`), prefer that
and ask for the code.

## A browser on this machine

When a sign-in only works in a browser on this machine (localhost callbacks,
cookies a tool reads from the browser), open one and show it to the user:

    bivy app run --name "Sign in" -- chromium --app="<url>"
    bivy app present "Sign in" --note "Sign in to Google here, then tell me in the chat"

They use it from their phone; it runs here, so `localhost` resolves. Remove it
when they are done (`bivy app list`, then `bivy app remove <app-id>`). It needs a display server on
this machine; `bivy app run` says if one is missing.

## Something only they can do

Turning on 2FA, approving an app, verifying an email, paying:

    bivy ask "Turn on 2-step verification for your Google account, then tap Done" \
      --url https://myaccount.google.com/signinoptions/two-step-verification \
      --option "Done" --option "I can't"

One step per card. Say why it is needed. If they can't, find another way or
explain what is blocked.

## Prefer, in order

1. A connection that is already set up (`bivy secrets exec`, a CLI that is already signed in).
2. A device-code sign-in: no key to copy, and it can be revoked from the service.
3. An API key with the narrowest scope the job needs.
4. A localhost paste-back, or the browser on this machine.
