# Quple

A tiny "call someone by username" desktop app built around
[Jitsi Meet](https://jitsi.org). Modeled on [quintodrome](../quintodrome), it
wraps a web app in a [Tauri](https://tauri.app) shell — but instead of hosting
a local sidecar server, it points at a hosted (or self-hosted) Jitsi Meet
deployment and uses a minimal central service to let two users find each
other and agree on a meeting room.

## How it works

1. **Sign in.** Everything is behind a Quine account at
   [login.quineglobal.com](https://login.quineglobal.com), Quine's Keycloak
   (the realm `public`, where anyone can sign up; Quple is its OIDC client
   `quple`). The app opens the sign-in page in the system browser. Your
   Quine username is what people call you by.
   **Contacts** are kept per person on the signaling server.
2. **Presence.** While the app is open, it polls the signaling server every
   few seconds, which doubles as "I'm online" and "did anyone call me?".
3. **Calling.** You call someone by username, on whichever Jitsi Meet
   server you like: meet.jit.si by default, or any other deployment (the
   app remembers the last one you used). Jitsi servers need no credentials
   from Quple, so nothing is set up on them. The signaling server mints a
   meeting ID and your app opens a window at `<jitsi>/<meeting-id>`.
4. **Receiving.** The callee's app sees the pending invite on its next poll,
   shows an "Incoming call from X on <server>" prompt, and — if accepted —
   opens the same meeting URL on the caller's chosen server. Jitsi Meet's
   own WebRTC signaling (XMPP + the videobridge) takes it from there;
   Quple's server never touches media or call content, it only introduces
   two clients to the same room name.
5. **Ringing.** The caller doesn't join the Jitsi room until
   the call is answered: it shows "Calling bob" and sends heartbeats
   (`/calls/{id}/heartbeat`). The callee's phone rings for 45 s, checking
   the call meanwhile (`GET /calls/{id}`, which isn't answering) and
   stopping if the caller cancels. Answering opens the callee's call screen,
   whose first heartbeat tells the caller's app, which joins the room then.
   Declining or ringing out hangs up, and the caller's app goes back to
   "bob didn't answer"; so it does after 60 s with no answer at all (the
   callee's app wasn't open). An invite for a call that's already been
   hung up isn't delivered.
6. **Ending.** Jitsi doesn't end a call when the other side leaves, so the
   iPhone app's call screen does, on any Jitsi server
   ([`mobile/src/watchdog.ts`](mobile/src/watchdog.ts)). Every 3 s it sends
   a heartbeat to the signaling server, which answers whether the other
   side hung up (or declined) and when their call screen last sent one, and
   it watches who's in the Jitsi room. It ends the call when the other side
   hangs up, hasn't answered after 60 s, or is gone from both the room and
   the server (45 s), and rejoins (remounts the Jitsi SDK) when it never got
   into the room or the other side is in the call but not in its room.
   Quple's server being down never ends a call Jitsi is still carrying.
   Hanging up, declining or letting it ring out sends `/hangup`, so the
   other app ends too.

   The desktop app does the same with a copy of the watchdog
   (`desktop/src/watchdog.js`, tested with `node --test
   desktop/test/*.test.mjs`). Its meeting window is plain web content with
   no access to the app, so a script injected into it reports the room
   (joined, how many others, from Jitsi's `window.APP`) through the page
   title, which the app reads (`desktop/src-tauri/src/lib.rs`). Closing
   that window, or Jitsi's hang-up button, hangs up.

Every request to the signaling server carries a Quine access token; the
server takes the caller's username (the token's `preferred_username`) from
it, never from the request, and only accepts access tokens issued to Quple
(`typ` Bearer, `azp` quple).

meet.jit.si only starts a meeting once a signed-in user joins, so when the
chosen server is meet.jit.si the app offers to sign you in to it (once; it's
remembered).

```
   Caller's Quple                Signaling server              Callee's Quple
   --------------                ----------------              --------------
   POST /call            ----->  mint meetingId,
   {to, jitsiUrl}
                                 queue invite for "to"
                         <-----  {meetingId, jitsiUrl}
   open window:
   <jitsiUrl>/<id>
                                                            GET /poll
                                                     <----- (polling every ~3s)
                                 return queued invite ----->
                                                            show "Incoming call
                                                            from X on <server>"
                                                            accept -> open window:
                                                            <jitsiUrl>/<id>
```

Both windows are now just two independent visitors to the same Jitsi Meet
room — the same as if they'd both manually opened
`https://meet.jit.si/quple-abc123` and shared the link.

## Layout

```
quple/
├── server/       # Go: the minimal central signaling service
├── desktop/      # Tauri desktop app (the thing each user runs); the UI is
│                 # Preact + htm, vendored, so there's no frontend build
└── jitsi-meet/   # Upstream jitsi-meet source, as its own git clone (ignored
                  # here; reference only, not built as part of this app —
                  # see below)
```

### Why `jitsi-meet/` isn't built

Quple doesn't build or serve jitsi-meet's frontend itself. It just navigates
a window to a room URL on *some* Jitsi Meet deployment, the same way a
browser tab would. By default that's the public `meet.jit.si`, which requires
no infrastructure at all. Running your own deployment needs Prosody (XMPP),
Jicofo, and JVB in addition to the web frontend in this repo — that's a
separate, heavier project (see jitsi-meet's own `doc/quick-install.md` and
`docker-compose` setup). The source is vendored here so it's easy to build a
custom/branded frontend later; once one is running, just type its URL as the
server when calling (or make it the signaling server's `DEFAULT_JITSI`).

## Running it

Requires Go 1.25+.

### 1. Quine sign-in

Nothing to run: Quple uses login.quineglobal.com
(`https://login.quineglobal.com/realms/public`), where the `quple` client is
set up by petersweb-infra (`nixos/keycloak/public-realm.nix`, docs/LOGIN.md).
Self-hosting later means any OIDC provider with a public client `quple`
that allows PKCE and a `http://127.0.0.1/callback` redirect on any port,
issues `preferred_username` as a username like login.quineglobal.com's
(3-32 of a-z, 0-9, `.`, `_`, `-`), and offers
`offline_access`; Keycloak does all of that.

### 2. Signaling server

```sh
cd server
go run .              # listens on :8080; set ADDR to change it
```

`ISSUER` (default `https://login.quineglobal.com/realms/public`) is the
identity server whose access tokens it accepts and `CLIENT_ID` (default
`quple`) the app they must be issued to. Every endpoint needs `Authorization: Bearer <access token>`.
`DEFAULT_JITSI` (default `https://meet.jit.si`) hosts calls that don't name a
server, and `DATA_DIR` holds contacts.

**Deploying** (meet.quineglobal.com) works like our other services: a push
to `main` that touches `server/` runs `.forgejo/workflows/deploy.yml`, which
tests it, builds `server/Containerfile` as
`forge.in.quineglobal.com/quine-global/quple-server` and opens a
petersweb-infra PR bumping its pinned digest (`nixos/quple/default.nix`).
Merging the PR deploys it. Restarting clears presence and any in-flight
invites; contacts are kept in `DATA_DIR`.

### Local signaling server

```sh
(cd server && ADDR=127.0.0.1:8090 go run .)
```

Then in the app's **Advanced settings** set the signaling server to
`http://127.0.0.1:8090`. It still signs in at login.quineglobal.com.

### 3. Desktop app

Requires a Rust toolchain (pinned via `desktop/rust-toolchain.toml`,
installed automatically by `rustup`) and, on Linux, the system WebView
packages Tauri needs (`webkit2gtk-4.1`, `gtk3`, `libappindicator3`,
`librsvg2` — see [Tauri's Linux prerequisites](https://v2.tauri.app/start/prerequisites/)).
On this machine those aren't installed at the OS level (it's an immutable/
atomic distro), so build it the same way quintodrome does for Linux: inside
the `flatpak-builder` distrobox, or via `rpm-ostree install` + reboot if you
want it on the host directly. macOS and Windows need no extra system
packages beyond Xcode CLT / the MSVC Build Tools.

```sh
cd desktop/src-tauri
cargo run
```

On first launch you'll land on **Sign in with Quine**, which finishes in your
browser and comes back to the app (RFC 8252: a one-shot listener on
`127.0.0.1`). The refresh token is kept in the app's data dir, readable only
by you; the webview only ever sees short-lived access tokens. The identity
and signaling server URLs are under **Advanced settings**, and later the gear
icon. The Jitsi server for a call is picked on the main screen.

To build a standalone app bundle:

```sh
cd desktop/src-tauri
cargo tauri build
```

#### Updates and releases (macOS)

Like Quintodrome's, the Mac app updates itself with
[Sparkle](https://sparkle-project.org/) through
[tauri-plugin-sparkle-updater](https://crates.io/crates/tauri-plugin-sparkle-updater):
**Quple › Check for Updates…**, a background check at every launch, and
Sparkle's daily one. Sparkle shows its native "A new version is available"
window and installs the update itself (`desktop/src-tauri/src/updater.rs`).

- **Building locally:** `bash desktop/scripts/download-sparkle.sh
  desktop/src-tauri` once (Sparkle.framework and its tools, git-ignored),
  then `cd desktop && SPARKLE_FRAMEWORK_PATH=$PWD/src-tauri npx
  @tauri-apps/cli@2 build`. Sparkle only runs in the packaged `.app`, not
  `cargo run`.
- **Releasing:** `git tag -a v1.2.3 -m "What's new" && git push origin
  v1.2.3`. `.forgejo/workflows/desktop.yml` builds both architectures on the
  Mac runner, publishes the Forgejo release (downloadable through
  git.quineglobal.com), and writes the Homebrew cask (`brew install --cask
  quine-global/tap/quple`) and one Sparkle appcast per architecture
  (`appcasts/quple-<arch>.xml`) into quine-global/homebrew-tap. The tag's
  message is the release notes, shown in Sparkle's update window.
- **Signing:** each update zip is signed with an Ed25519 key; the public half
  is `SUPublicEDKey` in `desktop/src-tauri/Info.plist`, the private half the
  `SPARKLE_PRIVATE_KEY` Actions secret. It's Quintodrome's and Hyper's key
  (the login Keychain's `hyper` account, backed up in 1Password as "Hyper
  Sparkle update signing key"); the appcasts are separate, so no app is
  offered another's updates. Pushing to the tap needs the
  `HOMEBREW_TAP_SSH_KEY` secret, a key with write access to the tap.
- **Version:** release builds take the tag's version (what people see);
  Sparkle compares `CFBundleVersion`, which is the workflow's run number, as
  is the appcast's `sparkle:version`.
- The app is only ad-hoc signed: the cask strips the quarantine flag, and
  says `auto_updates true`, so `brew upgrade` leaves it to Sparkle.

### 4. iPhone app (`mobile/`)

React Native 0.85 (the version the Jitsi Meet SDK, 13.3, supports), iOS
only. Same account, contacts and calling as the desktop app; calls happen in
the Jitsi Meet SDK, and incoming calls ring on iOS's own call screen
(CallKit).

- **Installed with AltStore**, re-signed with a free Apple ID, so no push
  notifications: a call only rings **while the app is open** (it polls the
  signaling server in the foreground, like the desktop app). Ringing when
  closed needs VoIP push, which needs the paid Apple Developer Program
  (then TestFlight); `src/callkit.ts` is where it would plug in.
- Sign-in: `com.quineglobal.quple:/oauth`, registered with the `quple`
  client (petersweb-infra docs/LOGIN.md). The refresh token is in the
  iOS Keychain.

**Installing:** in AltStore, Sources → + →
`https://packages.quineglobal.com/altstore.json`,
then install Quple from it; new builds show up as updates. It's Quine's
source, for all our iPhone apps (Quple is the first). CI
(`.forgejo/workflows/ios.yml`, on the Mac runner) builds every push to
`main` that touches `mobile/`, uploads the build to this repo's `altstore`
release, and replaces Quple's entry in the source
(`.forgejo/altstore-source.py`; the listing is `mobile/altstore.json`),
leaving other apps' alone.

Building by hand (on a Mac with Xcode and CocoaPods; our Mac mini has both):

```sh
cd mobile && npm ci && cd ios && pod install
xcodebuild -workspace QupleMobile.xcworkspace -scheme QupleMobile \
  -configuration Release -sdk iphoneos -destination generic/platform=iOS \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
mkdir -p ipa/Payload && cp -R build/Build/Products/Release-iphoneos/QupleMobile.app ipa/Payload/
(cd ipa && zip -qry ../build/Quple.ipa Payload)
```

Unsigned on purpose: AltStore signs it with your Apple ID when it installs
it (and again every 7 days). TypeScript: `npx tsc --noEmit` (the Jitsi
SDK's own sources don't type-check, so `types/` declares its API).

## Verification status

- **`server/`**: `go vet`-clean, with HTTP-level tests for auth, calls on
  the default and a caller-chosen Jitsi server (and refusal of non-http(s)
  or otherwise odd server URLs), and contacts; the token check against a
  fake Keycloak-shaped issuer (ID, refresh and other apps' tokens, other
  issuers, expired tokens and other keys are refused).
- **`mobile/`**: type-checks, and builds for iPhone (Release, unsigned)
  with Xcode 27.2. Not yet run on a phone: sign-in, CallKit ringing and a
  Jitsi call need a device.
- **`desktop/`**: builds with `cargo build` on macOS and runs. The Preact UI
  (Quine sign-in, contacts, picking the server for a call, the meet.jit.si
  sign-in prompt, incoming calls showing their server) is checked headlessly
  against a mocked backend. The browser sign-in round trip in the real app
  hasn't been driven automatically.

## Server API

All endpoints require `Authorization: Bearer <Quine access token>`; the
caller's username is the token's `preferred_username`.

| Method & path                | Body                                   | Returns |
|-------------------------------|-----------------------------------------|---------|
| `GET /me`                     | —                                       | `{"username":"alice","defaultJitsiUrl":"https://meet.jit.si"}` |
| `POST /register`              | —                                       | `{"ok":true}` — marks you online |
| `POST /call`                  | `{"to":"bob","jitsiUrl":"https://meet.jit.si"}` | `{"meetingId":…,"jitsiUrl":…}` — `jitsiUrl` is optional (default `DEFAULT_JITSI`) |
| `GET /poll`                   | —                                       | `{"invites":[{"from":…,"meetingId":…,"jitsiUrl":…,"createdAt":…}]}` — also marks you online, and clears delivered invites |
| `GET /calls/{meetingId}`            | —                                 | the same as a heartbeat's answer, without counting as one: for a phone that's ringing (has the caller given up?) |
| `POST /calls/{meetingId}/heartbeat` | —                                 | `{"peer":"bob","peerSeenMsAgo":1200,"endedBy":""}` — sent every few seconds from a call screen; `peerSeenMsAgo` is `null` until the other side's call screen opens (not answered; the caller's call screen is up from the start), `endedBy` is who hung up. Also marks you online. Only the call's two parties: 403 otherwise, 404 for unknown or long-idle calls |
| `POST /calls/{meetingId}/hangup`    | —                                 | `{"ok":true}` — ends the call for both sides (hanging up, declining, or the ring running out) |
| `GET /contacts`               | —                                       | `{"contacts":[{"username":…,"online":true}]}` |
| `POST /contacts`              | `{"username":"bob"}`                    | the added contact |
| `DELETE /contacts/{username}` | —                                       | `{"ok":true}` |

Presence expires 90s after the last `/register` or `/poll`. Undelivered
invites expire after 2 minutes.
