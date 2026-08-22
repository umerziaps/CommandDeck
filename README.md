# Command Deck

A personal task board — Now / Waiting / Later, categories, sub-tasks,
urgent flags, due dates — running as a **native iOS app** and a **web app**
over one shared Firestore backend.

```
CommandDeck/
  CommandDeck.xcodeproj      the iOS app (Xcode 16+, iOS 17+)
  CommandDeck/               its Swift sources
  docs/                      the web SPA — what both hosts serve
  firebase.json              Firebase Hosting + rules deployment config
  firestore.rules            security rules; publish these before using it
  firestore.indexes.json     empty on purpose — no composite indexes needed
  Info.plist                 needs your REVERSED_CLIENT_ID pasted in
  FIREBASE-SETUP.md          ← start here
```

**→ [FIREBASE-SETUP.md](FIREBASE-SETUP.md) is the setup guide.** Nothing
works until Firebase is configured; both clients tell you so on screen
rather than failing silently.

---

## The two clients

**iOS** — SwiftUI, iOS 17+. Firestore snapshot listeners drive the board;
the SDK's local cache means it opens and accepts edits with no signal, and
queued writes flush on reconnect. Local notifications fire on the morning
an item is due (no push entitlement, so a free Apple account is fine).

**Web** — plain HTML/CSS/ES modules with the Firebase SDK from the CDN.
No npm, no bundler, no build step, no Actions workflow. Because it's static,
it runs on **GitHub Pages and Firebase Hosting equally** — the repo is set
up for both, and they can serve the same `docs/` folder at the same time
(the setup guide compares the two deploy models). It's a PWA, so iOS Safari
can "Add to Home Screen" and get the icon and a standalone window.

Both sign in with Google and land on `users/{uid}/…`, which is what makes
them the same board rather than two.

---

## Data

Items and categories live in Firestore. The schema — and why dates are
strings rather than Timestamps — is documented in
[FIREBASE-SETUP.md](FIREBASE-SETUP.md#whats-stored-where).

**Notes & Logins does not sync.** It stays in local SwiftData on the
iPhone, gated behind Face ID, and the web app has no screen for it. That's
deliberate: credentials don't belong in a browser tab, and Firestore is not
a password manager.

### Backups

Both clients export and import the same JSON (schema `command-deck` v3) —
the same format the original web artifact used, so an old backup restores
into either one. Restoring **replaces everything on the account**, on every
signed-in device.

---

## Design notes

**Urgent doesn't re-sort on every render.** The original board forced urgent
items to the top on each draw, which fights drag-to-reorder — an item
dragged above an urgent one snaps back. Here, marking something urgent lifts
it to the top of its bucket *once*; after that you decide where it sits. The
red edge still marks it wherever it lands. Both clients implement the same
rule.

**Details are a screen on iOS, a drawer on web.** Phone screens are too
narrow for the inline expander the web version used.

**Writes aren't awaited in the UI.** Firestore applies them to the local
cache immediately and the snapshot listener re-renders, so awaiting the
network round-trip would only add latency to something already done.

**Text fields keep a local draft.** Typing directly into a value that a
listener keeps replacing is unusable, so titles and "waiting on" debounce
for half a second before committing.

---

## Running the web app locally

```bash
cd docs && python3 -m http.server 8000
```

Then <http://localhost:8000>. It must be served over HTTP — ES modules
don't load from `file://`. `localhost` is authorised in Firebase by default.

## Regenerating the icon

`icon.py` draws it (three stacked cards, one per bucket) and writes both the
iOS `AppIcon` asset and the web favicon sizes. Needs Pillow.

---

## Worth building next

- **A home-screen widget** showing the Now bucket. Needs an App Group.
- **Shortcuts / Siri capture** — "add to Command Deck" via an App Intent.
- **A service worker** so the web app works fully offline, not just cached.
