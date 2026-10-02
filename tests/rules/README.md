# Firestore rules tests

Everything under `docs/` tests the client. This tests the half of the system the
client cannot reach: the security rules, which run on Google's servers and are
the only thing standing between the vault and anyone else.

It exists because of a real failure. Groups were added, `firestore.rules` in this
repo was updated, every client test passed — and creating a group in the live app
returned *"Missing or insufficient permissions"*. The rules had never been
deployed. The repo and the running project had silently diverged, and nothing in
the pipeline could notice.

## Running it

Needs Java (the emulator is a JAR) and a few hundred MB of node_modules, which is
why it is deliberately not part of the root `npm test` — the web client and its
tests still have no dependencies at all.

    cd tests/rules
    npm install
    npm test

The emulator downloads its JAR from storage.googleapis.com on first run, so this
needs unrestricted network access. It will not run inside a sandbox that
allow-lists egress.

## What it covers

- A group document written exactly as `addGroup` writes it is accepted,
  **including the absence of `updatedAt`** — the case that was broken.
- A group carrying a plaintext `name`, or an entry carrying a plaintext
  `password`, is refused. This is the ciphertext-only guarantee, enforced by the
  server rather than trusted to the client.
- A malformed sealed blob — missing `ct`, missing `iv`, empty `ct`, or an extra
  field smuggled alongside them — is refused.
- The vault config must carry a real salt and a serious iteration count.
- Another signed-in user, and a signed-out one, get nothing.
- An unknown collection under your own user id is still denied.
- Board items and categories are unaffected.

## Deploying rules

`firebase deploy` from the repo root deploys hosting only unless told otherwise.
Rules go up with:

    firebase deploy --only firestore:rules

The `deploy-rules` job in `.github/workflows/web.yml` does this on every push to
`main`, so the divergence that caused this cannot happen again.
