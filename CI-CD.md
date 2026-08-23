# CI/CD

Three pipelines, one repo, no cost. This doubles as the explanation of what
each piece is for — read it top to bottom once, then use the secrets table
as a checklist.

```
.github/workflows/
  web.yml       test  →  deploy to GitHub Pages + Firebase Hosting
  android.yml   test  →  lint  →  build APK  →  Firebase App Distribution
  ios.yml       build →  test                 (no delivery — see below)
```

---

## The one thing that decides your bill

**Keep this repository public.** GitHub Actions is free and unmetered on
standard runners for public repositories, macOS included.

On a **private** repo you get a fixed monthly allowance instead, and minutes
are weighted by runner: Linux 1×, Windows 2×, **macOS 10×**. A five-minute
iOS build therefore costs fifty minutes of allowance. Two or three pushes a
day and you're done for the month.

Nothing in this repo is secret. The Firebase web config is a project
identifier, not a credential — your Firestore rules are what protect the
data. The two files that *are* environment-specific
(`google-services.json`, `GoogleService-Info.plist`) are gitignored and
injected from secrets at build time, which is the pattern you'd want at work
anyway.

---

## CI vs CD, concretely

**CI — continuous integration.** Every push, a clean machine checks out your
code, builds it from scratch, and runs the tests. It answers one question:
*does this actually work somewhere that isn't my laptop?* That catches the
whole class of "works on my machine" — a file you forgot to commit, a
dependency you have installed globally, a compiler error only the newer
Swift enforces.

**CD — continuous delivery/deployment.** When CI passes, the artifact goes
somewhere useful automatically. No one runs `firebase deploy` by hand and no
one forgets to.

The link between them is one line in `web.yml`:

```yaml
deploy-pages:
  needs: test        # ← this job does not start unless `test` succeeded
```

Delete that line and you have two unrelated jobs. Keep it and you have a
pipeline. That's genuinely the whole idea.

---

## What each pipeline does

### `web.yml` — the complete one

| Job | When | What |
|---|---|---|
| `test` | every push and PR | `npm test` — 29 unit tests, ~1s |
| `deploy-pages` | push to `main`, if tests pass | publishes `docs/` to GitHub Pages |
| `deploy-firebase` | push to `main`, if tests pass | deploys `docs/` to Firebase Hosting |
| `preview` | pull requests | a throwaway Firebase URL that expires in 7 days |

The two deploy jobs both declare `needs: test` and neither depends on the
other, so they run **in parallel** once tests are green. You'll see that in
the run graph.

> **Required setting:** Settings → Pages → Source must be **GitHub Actions**,
> not "Deploy from a branch". Left on branch deployment, Pages publishes on
> every push regardless of whether tests passed — which defeats the point —
> and the `deploy-pages` job fails.

### `android.yml` — the other complete one

Unit tests → Android Lint → assemble a debug APK → upload it as a
downloadable artifact → push it to Firebase App Distribution.

The APK is debug-signed and installs on any phone with "install unknown
apps" enabled — no Play Console account, no release keystore.

One catch worth understanding: a runner is a disposable VM, so left to
itself Gradle generates a **new** debug keystore every run, with a new
signing fingerprint. Google checks that fingerprint during sign-in, so those
APKs would install and then fail to sign in. The `DEBUG_KEYSTORE_BASE64`
secret hands CI the same keystore your Mac uses, which fixes it. Skip the
secret and the build still passes — it just warns, and the APK can't sign
in.

**Release** signing is a different matter: it needs a real keystore whose
loss is unrecoverable and whose leak lets someone ship updates as you. It's
deliberately not set up here.

### `ios.yml` — CI only, and why

Builds and tests on a real macOS runner. It does **not** deliver anything,
because it can't: TestFlight requires App Store Connect, which requires the
paid Apple Developer Program. Firebase App Distribution for iOS needs an
ad-hoc provisioning profile — same wall.

That's still the majority of the value. `CODE_SIGNING_ALLOWED=NO` lets the
simulator build and the tests run with no Apple membership at all. The
actor-isolation error you hit in `AuthService` would have appeared here
first, in a pipeline, instead of on your Mac.

If you ever pay the $99, the missing piece is an `archive` + `upload to
TestFlight` step using `fastlane` or `xcodebuild -exportArchive`, plus
certificate and provisioning-profile secrets.

---

## Secrets

Repository → **Settings → Secrets and variables → Actions → New repository
secret**.

Every one of these is optional. Jobs that need a missing secret **skip
themselves with a note** rather than failing, so your pipeline is green from
the very first push and you can add capability as you go.

| Secret | Used by | Where it comes from |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | web deploy, web preview, Android distribute | see below |
| `FIREBASE_PROJECT_ID` | web deploy | your Firebase project id, e.g. `command-deck-1a2b3` |
| `FIREBASE_ANDROID_APP_ID` | Android distribute | Project settings → Your apps → Android → App ID (`1:123…:android:abc…`). You also need App Distribution switched on and a `testers` group — [FIREBASE-SETUP.md §8](FIREBASE-SETUP.md) |
| `GOOGLE_SERVICES_JSON` | Android build | contents of the `google-services.json` you downloaded, pasted whole |
| `DEBUG_KEYSTORE_BASE64` | Android build | `base64 -i android/debug.keystore \| pbcopy`. Without it, CI-built APKs can't do Google sign-in — [FIREBASE-SETUP.md §8](FIREBASE-SETUP.md) explains why |
| `GOOGLE_SERVICE_INFO_PLIST` | iOS build | `base64 -i GoogleService-Info.plist \| pbcopy` on your Mac, then paste |

### Creating the service account

This is the only fiddly one.

1. [Google Cloud console](https://console.cloud.google.com) → make sure your
   Firebase project is selected → **IAM & Admin → Service Accounts**.
2. **Create service account**, name it `github-actions`.
3. Grant it **Firebase Hosting Admin**. Add **Firebase App Distribution
   Admin** too if you want Android distribution.
4. Open it → **Keys → Add key → Create new key → JSON**. A file downloads.
5. Paste the **entire contents** of that JSON file as the value of
   `FIREBASE_SERVICE_ACCOUNT`.

That file *is* a real credential — anyone holding it can deploy to your
project. Don't commit it, don't paste it in a chat, and delete the download
once it's in the secret. If it leaks, delete the key in the Cloud console
and make a new one; that instantly invalidates the old one.

---

## The tests, and why these ones

Tests only earn their keep if they fail when something is genuinely broken.
These target the two things most likely to break silently across three
clients:

**Wire-format mapping** (`ItemMappingTest.kt`, `ItemMappingTests.swift`,
`lib.test.js`). iOS, Android and web all read and write the same Firestore
documents. Rename a field on one and nothing throws — the other two read
back a default, and a task quietly loses its due date on one platform. Each
client asserts the exact set of field names, so a rename fails CI until all
three agree.

Also covered because each has bitten real apps:

- Firestore returns every number as `Long`/`NSNumber`; casting straight to
  `Int` yields null and silently resets an item's position.
- An unset due date must serialise as `""`, not `null` — the web date input
  renders `null` as "Invalid Date".
- An unknown bucket value must fall back to Later, not vanish.
- A malformed date in one document must not take down the whole board.

**Ordering** (`BoardOrderTest`, `BoardOrderTests`, and the ordering block in
`lib.test.js`). Small rules, immediately visible when wrong. There's an
explicit test that urgent items *don't* re-sort on every read — the
behaviour the original web artifact had, which fought drag-to-reorder. A
test that asserts a deliberate design decision is documentation that can't
go stale.

The Swift suite also checks the comparator is a strict weak ordering, since
an inconsistent one makes Swift's `sort` **trap at runtime**, not just
misorder.

**Dates** (`DeckDateTest`, `DeckDateTests`, and the dates block in
`lib.test.js`). Every one of these passes "today" in as a parameter. A test
that reads the real clock passes in the morning and fails at midnight, and a
suite people learn to re-run until it's green is worse than no suite.

> **This already paid off.** Writing `lib.test.js` caught a live bug: the web
> client used `toLocaleDateString`, and `en-GB` now renders September as
> "Sept". The same task read "14 Sep" on iOS and "14 Sept" on the web. It's
> a fixed month table in `lib.js` now.

### Running them yourself

```bash
npm test                                    # web  — instant
cd android && ./gradlew test                # android — JVM only, no emulator
# iOS: ⌘U in Xcode, or
xcodebuild test -scheme CommandDeck -destination 'platform=iOS Simulator,name=iPhone 16'
```

Nothing here needs an emulator or a simulator farm. That's deliberate:
tests you won't run locally are tests you'll learn to ignore in CI.

---

## Your first run

1. **Push to GitHub** with the repo public.
2. **Settings → Pages → Source → GitHub Actions.**
3. Watch the **Actions** tab.

Expect this on the first attempt:

- **Web — green.** Nothing external needed. Pages deploys; Firebase is
  skipped with a note until you add the service account.
- **Android — green, but slow.** First run downloads the whole Android
  toolchain; five minutes or so. Later runs hit the Gradle cache.
- **iOS — likely red the first time.** Two normal reasons: the Firebase
  Swift packages aren't committed yet (add them in Xcode, then commit the
  changed `project.pbxproj` **and** `Package.resolved`), or a pinned
  dependency version doesn't resolve.

A red X on the first iOS run isn't a failure of the setup, it's the setup
doing its job. Read the log, fix, push again.

### Reading a failure

Actions tab → the run → the red job → expand the red step. The error is
almost always in the last 20 lines. Then:

- **Android test failures** → download the `android-test-report` artifact
  from the run summary; open `index.html` for a readable diff.
- **iOS test failures** → download `ios-test-results`, open the `.xcresult`
  in Xcode.
- **Web test failures** → the log *is* the report; Node prints the expected
  and actual values inline.

---

## Deliberately not automated

**iOS delivery** — blocked by the $99 wall, covered above.

**Release signing for Android** — needs a keystore file and its passwords as
secrets. Doable (base64 the keystore into a secret, same shape as the plist)
but it's the one secret where a leak means someone can ship an update
*as you*. Worth doing consciously, not by copying a snippet.

**Firestore rules deploys.** `firebase.json` already points at
`firestore.rules`, so `firebase deploy --only firestore:rules` works from
your laptop. Automating it is a genuinely good next step — rules are code
and belong in the pipeline — but a bad rules deploy locks you out of your
own data, so add it once you're comfortable reading a failed run.

---

## Worth trying next

- **Branch protection.** Settings → Branches → require the `test` job to
  pass before merging. This is the moment CI stops being advisory.
- **Work on a branch, open a PR.** The preview-channel job gives you a live
  URL for the change before it hits `main`. This is the workflow the setup
  is actually designed around.
- **Break something on purpose.** Change `"catId"` to `"categoryId"` in
  `docs/lib.js` and push. Three clients disagree, and CI tells you before
  your phone does. That's the whole return on writing the tests.
- **A status badge** in `README.md`:
  `![Web](https://github.com/<user>/<repo>/actions/workflows/web.yml/badge.svg)`
