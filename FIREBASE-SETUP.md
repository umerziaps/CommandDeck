# Setting up Firebase, the web app, and the iPhone app

Roughly 25 minutes end to end (add ten if you set up both hosts). No credit card — everything here runs on
Firebase's free **Spark** plan.

> **Why Firestore and not Firebase Storage?** Storage is a blob store for
> files, and since September 2024 it requires the paid Blaze plan with no
> free tier at all. Firestore is a document database — the right shape for
> a task board, with per-item sync and offline caching — and stays free:
> 50,000 reads/day, 20,000 writes/day, 1 GiB stored. A personal board uses
> a rounding error of that.

---

## 1. Create the project

1. <https://console.firebase.google.com> → **Create a project**.
2. Name it whatever you like (`command-deck`).
3. Google Analytics: **off**. Nothing here needs it.

## 2. Turn on Firestore

1. **Build → Firestore Database → Create database**.
2. Choose a location near you. **This cannot be changed later.**
3. Start in **production mode** — it denies everything by default, which is
   what you want until step 3 replaces the rules.

## 3. Publish the security rules

**Firestore Database → Rules**. Replace what's there with the contents of
[`firestore.rules`](firestore.rules) in this repo, then **Publish**.

These rules are the only thing protecting your board. Read them before you
publish — they're short and commented. The gist: every document lives under
`users/{yourUID}/…` and only that signed-in user can touch it.

Once you've signed in for the first time, come back and apply the optional
UID pin at the bottom of that file. It stops anyone else signing in and
creating a board inside your project.

## 4. Turn on Google sign-in

**Build → Authentication → Get started → Sign-in method → Google → Enable**.
Set a support email (your own), save.

---

## 5. The web app

### Register it

**Project settings** (gear icon) → **General** → scroll to *Your apps* →
click the **`</>`** (web) icon. Nickname it `command-deck-web`. Ticking
"also set up Firebase Hosting" here is optional — the config in this repo
already covers it, and you can turn Hosting on later either way.

Firebase shows you a config object. Copy the values into
[`docs/firebase-config.js`](docs/firebase-config.js), replacing the
`PASTE_…` placeholders.

> That file is safe to commit publicly. The Firebase web API key is a
> project identifier, not a credential — it authorises nothing on its own.
> Your rules plus Google sign-in are the actual protection.

### Test it locally first

```bash
cd docs && python3 -m http.server 8000
# then open http://localhost:8000
```

Open it over `http://`, not by double-clicking the file — ES modules don't
load from `file://`. `localhost` is authorised in Firebase by default, so
sign-in works straight away.

---

## 6. Hosting — pick one, or run both

The app is plain static files with no build step, so **any** static host
serves it and nothing in the code changes between them. Running both is a
genuinely useful exercise: the same folder, two very different deploy
models, and you get to watch one CDN behave differently from the other.

|  | GitHub Pages | Firebase Hosting |
|---|---|---|
| Deploy trigger | `git push` | `firebase deploy` |
| Source of truth | a branch/folder in the repo | whatever's on your disk |
| URL | `<user>.github.io/<repo>/` | `<project>.web.app` |
| Sign-in domain | you must authorise it | authorised automatically |
| Rollback | revert a commit | one click in the console |
| Custom headers | none | yes (see `firebase.json`) |
| Serves your Firestore rules too | no | yes, same CLI |

The big conceptual difference: Pages deploys *what is committed*, Firebase
deploys *what you point the CLI at*. Pages is harder to deploy something
untracked by accident; Firebase is faster to iterate and can push a
half-finished folder if you're not careful. Worth feeling both.

### Option A — GitHub Pages

Push this repo to GitHub, then **Settings → Pages**:

- **Source:** Deploy from a branch
- **Branch:** `main`, folder **`/docs`**

Give it a minute. Your board lands at
`https://<your-username>.github.io/<repo-name>/`.

That `/docs` folder name is not a coincidence — Pages only serves from the
repo root or a folder literally called `docs`, which is why the web app
lives there rather than in something like `web/`.

If you'd rather have it at `https://<your-username>.github.io/` with no
subpath, name the repo `<your-username>.github.io` and move the contents of
`docs/` to the repo root, setting Pages to the root folder instead.

**Then authorise the domain:** **Authentication → Settings → Authorized
domains → Add domain** → `<your-username>.github.io`.

Skip that and sign-in fails with `auth/unauthorized-domain`. The web app
watches for that specific error and says so on screen rather than failing
mutely.

### Option B — Firebase Hosting

```bash
npm install -g firebase-tools
firebase login
cd CommandDeck          # the folder with firebase.json in it
firebase use --add      # pick your project, alias it "default"
firebase deploy --only hosting
```

Live at `https://<project-id>.web.app` (and `.firebaseapp.com`). **Both are
authorised for sign-in automatically** — no Authorized-domains step.

> **Do not run `firebase init hosting`.** [`firebase.json`](firebase.json)
> is already in the repo, pointing at `docs/` with sensible cache headers.
> `init` would ask to overwrite `index.html` — and its default answer is
> yes, which replaces the app with Firebase's placeholder page. If you do
> run it out of curiosity, answer **No** to overwriting `index.html`, and
> **No** to "configure as a single-page app" (that rewrite makes every 404
> return `index.html`, which hides real mistakes; this app has no
> client-side router and doesn't need it).

**Bonus — deploy your security rules from the CLI too:**

```bash
firebase deploy --only firestore:rules
```

`firebase.json` points at [`firestore.rules`](firestore.rules), so this
replaces the copy-paste in step 3. Keeping rules in version control next to
the code that depends on them is how you'd want to do this on a real
project — the console becomes somewhere you *read* rules, not edit them.

`firestore.indexes.json` is deliberately empty: both clients read whole
collections and sort in memory, so there's nothing to index yet.

### Running both

Nothing conflicts. The same `docs/` folder can be live on both hosts at
once — same Firestore data, same account, same board. Just remember Pages
serves your last *push* while Firebase serves your last *deploy*, so the
two can drift out of step, which is itself instructive the first time it
happens to you.

Also useful:

```bash
firebase hosting:channel:deploy preview
```

That publishes to a temporary preview URL that expires in 7 days, without
touching your live site. GitHub Pages has no equivalent.

Once the CLI is installed you also get a local server that applies the
headers and rewrites from `firebase.json`, which the plain Python one
doesn't:

```bash
firebase emulators:start --only hosting
```

Handy when you want to confirm a hosting config change before deploying it.

---

## 7. The iPhone app

### Register it

**Project settings → General → Your apps → Add app → iOS**.

- **Bundle ID:** must exactly match the one in Xcode. It's
  `com.umerzia.CommandDeck` unless you changed it.
- Download **`GoogleService-Info.plist`**.

### Add the file to Xcode

Drag `GoogleService-Info.plist` into the `CommandDeck` folder in the Xcode
navigator. **Tick "Copy items if needed" and make sure the CommandDeck
target is checked** — an unticked target is the most common reason sign-in
mysteriously fails.

The app checks for this file at launch. If it's missing you get a screen
explaining what to add rather than a crash.

### Add the SDKs

**File → Add Package Dependencies…**, twice:

| URL | Products to add |
|---|---|
| `https://github.com/firebase/firebase-ios-sdk` | `FirebaseAuth`, `FirebaseFirestore` |
| `https://github.com/google/GoogleSignIn-IOS` | `GoogleSignIn` |

The Firebase package is large and resolves slowly the first time — several
minutes is normal. Add only the two products listed; pulling in all of
Firebase bloats the build for no reason.

> These are added through Xcode rather than pre-wired into the project file
> on purpose: hand-editing package references into a `.pbxproj` is exactly
> the kind of thing that produces a project that won't open.

### Set the URL scheme

Open the downloaded `GoogleService-Info.plist` and copy the value of
**`REVERSED_CLIENT_ID`** — it looks like
`com.googleusercontent.apps.123456789012-abc…`.

Paste it into [`Info.plist`](Info.plist) in place of the literal string
`REVERSED_CLIENT_ID`, under `CFBundleURLTypes`.

Google opens this URL to hand the sign-in result back; without it the
sheet closes and nothing happens.

### Build and run

Sign in with the same Google account on both. Add something on the phone
and it appears in the browser within a second or so, and the reverse.

---

## What's stored where

```
users/{uid}/items/{itemId}
  title      string
  bucket     'now' | 'waiting' | 'later'
  done       bool
  doneAt     string (ISO 8601) | null
  waitingOn  string
  due        string ('yyyy-MM-dd', '' when unset)
  subs       [{ id, text, done }]
  catId      string ('' when uncategorized)
  urgent     bool
  order      number
  createdAt  string (ISO 8601)

users/{uid}/categories/{categoryId}
  name       string
  color      string ('#RRGGBB')
  createdAt  string (ISO 8601)
```

Dates are **strings, not Firestore Timestamps**. That's deliberate: it keeps
the two clients and the JSON backup format identical, with no timezone
conversion in the middle to get subtly wrong. Sub-tasks are embedded on the
item rather than living in a subcollection, so an item is one read and one
atomic write.

If you change a field name, change it in **both**
`docs/app.js` (see its `SCHEMA` comment) and
`CommandDeck/Models/Item.swift` (the Firestore mapping extension).

### Not synced, on purpose

**Notes & Logins** stays in local SwiftData on the iPhone, behind Face ID.
It never reaches Firestore and the web app has no screen for it. Credentials
shouldn't be sitting in a browser tab, and a JSON document store is not a
password manager. Export/import still carries them in the backup file, since
that file never leaves your machine unless you send it somewhere.

---

## Troubleshooting

**`auth/unauthorized-domain` on the web** — you're on the GitHub Pages URL
and haven't authorised it: Authentication → Settings → Authorized domains.
Firebase Hosting URLs (`.web.app` / `.firebaseapp.com`) never need this.

**Sign-in sheet opens on iOS, closes, nothing happens** — the URL scheme
doesn't match. Re-check `REVERSED_CLIENT_ID` in `Info.plist`.

**"Permission denied" in either client** — the rules aren't published, or
you applied the optional UID pin with the wrong UID. Find your real one
under Authentication → Users.

**iOS shows the "Firebase isn't set up yet" screen** — `GoogleService-Info.plist`
isn't in the bundle. Usually it was dragged in without the target ticked;
check Target → Build Phases → Copy Bundle Resources.

**Web app stuck on "Connecting…"** — `firebase-config.js` still has the
`PASTE_…` placeholders, or the browser console has the real error. Open it.

**Firebase Hosting shows a "Welcome" placeholder page** — `firebase init`
overwrote `docs/index.html`. Restore it from git (`git checkout docs/index.html`)
and deploy again without running `init`.

**The two hosts show different things** — expected. Pages serves your last
`git push`; Firebase serves your last `firebase deploy`. Push and deploy to
bring them back in step.

**`firebase deploy` says "No project active"** — run `firebase use --add`
first and pick the project.

**Items appear on one client but not the other** — check both are signed in
with the *same* Google account. Different accounts mean different UIDs and
therefore different boards, working exactly as designed.

**Nothing syncs and the phone shows the offline icon** — Firestore is
serving from cache. Writes are queued, not lost; they flush on reconnect.
