# Chromecast Integration

How echoai casts audio to a Chromecast, what the Google Cast SDK actually
guarantees, and which parts of our implementation depend on which guarantee.

Every claim about the Cast platform below cites the Google source it came from.
Where the official docs are silent, this document says so rather than guessing —
those gaps are exactly where our integration carries risk.

---

## 1. Cast in one page

A Cast setup has two halves:

| Role | Runs on | In echoai |
|---|---|---|
| **Sender** | Chrome tab on a laptop/phone | `app.js` in default mode |
| **Web Receiver** | The Chromecast device itself | `app.js` loaded with `?mode=receiver` |

The sender does *not* stream audio to the Chromecast. It tells the Chromecast a
**URL**, and the Chromecast fetches the media itself, over its own network stack,
as a separate HTTP client. This single fact drives our whole auth design: the
Chromecast has **no access to the browser's cookies**, so a cookie-authenticated
media URL is unreachable to it.

### The three receiver types

Google offers three, and the choice is not cosmetic
([overview](https://developers.google.com/cast/docs/web_receiver),
[registration](https://developers.google.com/cast/docs/registration)):

| Type | Custom UI | Registration | Custom logic / messages |
|---|---|---|---|
| **Default Media Receiver** | "cannot customize any of the UI" | not required | "not practical for receivers that require custom business logic" |
| **Styled Media Receiver** | CSS file only | required | no |
| **Custom Web Receiver** | full HTML5 app you host | required | yes — this is the only one that runs your JavaScript |

**echoai requires a Custom Web Receiver.** The on-TV transcript, the D-pad
episode picker, and the `urn:x-cast:com.echoai.auth` auth channel are all custom
JavaScript. They exist only in *our* HTML, and our HTML is only loaded if the
Chromecast was told to load a **registered app ID that points at our URL**.

> The Default Media Receiver is Google-hosted. It never loads echoai's page, so
> under it there is no transcript, no picker, and nothing listening on our
> namespace. See the audit finding **C-1** — our fallback app ID is exactly this.

### Registration is mandatory

From [Registration](https://developers.google.com/cast/docs/registration):

1. Sign in to the [Cast Developer Console](https://cast.google.com/publish).
2. **Add New Application → Custom Receiver.**
3. Enter a name and the **receiver URL** — for echoai that is the public
   `https://…/?mode=receiver` URL served through the Cloudflare Tunnel.
4. Save. You are given the **application ID** — this is what
   `TRANSCRIPT_VIEWER_CAST_RECEIVER_APP_ID` must be set to.
5. Publish when ready.

**Testing an unpublished receiver additionally requires registering the device.**
"By default, Google Cast devices … are not enabled for development and testing …
you must register the device with your app." You enter the device **serial
number**, then "**Wait fifteen minutes**" until the status reads *Ready for
Testing*, then power-cycle the device. Skipping this is the most common reason a
correct integration appears to do nothing.

### TLS rules

- **Receiver URL:** "During development, the URL can use HTTP but when the app is
  published it has to use HTTPS … It's okay for your Web Receiver to be on an
  internal (NAT-registered) IP address, **but not on localhost**."
  ([registration](https://developers.google.com/cast/docs/registration))
- **Media content:** "the content loaded on the Web Receiver app may be served
  over HTTP." (same page)
- **Sender page:** "**Web Sender apps need to support HTTPS to maintain Cast
  compatibility**, as browsers have deprecated support for the Presentation API on
  insecure origins."
  ([web sender setup](https://developers.google.com/cast/docs/web_sender))

Consequence for us: casting cannot be tested from `http://localhost:5000`.
It requires the Cloudflare Tunnel hostname (or another HTTPS origin) on both
ends. Self-signed certificates are **not addressed in the docs** — treat them as
unsupported.

---

## 2. echoai's topology

`app.js` is one file that runs in two modes, selected by query string
(`app.js:132`):

```
?mode=receiver  or  ?receiver=1   → receiver mode
(anything else)                   → sender mode
?castDebug=1                      → on-screen debug log panel
?receiverAppId=XXXXXXXX           → override the app ID (testing)
```

`index.html:16` has an inline bootstrap that loads the **Receiver** SDK only when
`?mode=receiver` is present — the sender must not load the receiver framework and
vice versa.

### SDK entry points we use

| Side | Script | Source |
|---|---|---|
| Receiver | `cast_receiver_framework.js` (gstatic) | [custom web receiver](https://developers.google.com/cast/docs/web_receiver/basic) |
| Sender | `cast_sender.js?loadCastFramework=1` (gstatic) | [integrate](https://developers.google.com/cast/docs/web_sender/integrate) |

Google is explicit: "**Do not self-host the `cast_receiver_framework.js`
resource, not even for local development**" — it is kept at parity with device
firmware. We load both from gstatic, which is correct. Google also recommends
**omitting the protocol** so the SDK is fetched over the same scheme as the page;
we hardcode `https://` (audit finding **C-6**).

On the sender, Chrome's built-in Cast extension may already have injected the
framework. `initCastSender` (`app.js:783`) checks `window.cast.framework` first
and only injects `cast_sender.js` if absent, registering
`window.__onGCastApiAvailable` beforehand — which matches the documented
contract: "You should ensure that the app sets this handler on the window
**before** loading the sender library."

---

## 3. The authentication model

This is the part of the integration that is entirely ours, and the part most
likely to break.

**The problem.** The Chromecast fetches `/media/<episode>.mp3` itself. It sends
no session cookie. But every echoai route is behind `require_authentication`
(`transcript_viewer.py:398`), and the receiver also needs `/api/episodes`,
`/api/episode/<id>`, and the translate endpoints for the on-TV transcript.

**The solution.** A short-lived HMAC-signed bearer token, minted by the
authenticated sender and handed to the receiver over a custom Cast namespace.

### Token format

Minted by `_mint_cast_token` (`transcript_viewer.py:335`):

```
base64url(json{ep, exp, nonce}) "." base64url(HMAC-SHA256(payload, CAST_SIGNING_KEY))
```

- `ep` — the **scope**: either a specific episode id, or `_auth`
  (`CAST_SCOPE_ANY`) meaning *any episode*, used for the receiver's own token.
- `exp` — absolute expiry, `TRANSCRIPT_VIEWER_CAST_TOKEN_TTL_SECONDS`, default
  10800s (3h). It must exceed the longest episode, because the media URL handed
  to the Chromecast embeds the token and is **never rewritten** — a seek after
  expiry would fail. See audit finding **C-2**.
- `nonce` — 8 random bytes; makes tokens non-identical, not replay-proof.

`_verify_cast_token` (`transcript_viewer.py:341`) checks the signature with
`hmac.compare_digest` **before** parsing the payload, then checks expiry. Tokens
are stateless — there is no revocation list, so a leaked token is valid until
`exp`.

### How the receiver gets it

The custom namespace is `urn:x-cast:com.echoai.auth` (`app.js:322`). Namespaces
"must begin with `urn:x-cast:`"
([core features](https://developers.google.com/cast/docs/web_receiver/core_features)),
so this is well-formed. Point-to-point messages have a **64 KB limit**.

```
sender                                    receiver (Chromecast)
──────                                    ─────────────────────
SESSION_STARTED / SESSION_RESUMED
  └─ sendAuthToReceiver()                 context.addCustomMessageListener(NS)
       wait 500 ms (best effort)          SENDER_CONNECTED
       POST /api/cast/session {_auth}       └─ sendCustomMessage({type:"ready"})
         → token (scope=_auth)                        │
       session.sendMessage(NS, auth) ────▶ receiverAuthToken = token
       on "ready" ─ re-mint & resend ◀──────────────── ┘
  └─ every 0.8 × TTL: re-mint & resend ──▶ receiverAuthToken = (new token)
```

The `ready` handshake exists because the initial push is timing-dependent: the
sender waits a fixed 500 ms and the receiver may still be booting. The receiver
therefore announces itself on `SENDER_CONNECTED` — strictly after its listener is
registered — and the sender re-sends. Either path alone is a race; together they
are not.

The receiver then attaches the token two ways (`app.js:460`, `app.js:1190`):

- **API calls** — `X-Cast-Token: <token>` header on every `fetchJson`.
- **Media URL** — `?rt=<token>` appended, because the Chromecast's media fetch is
  made by the platform's media stack, not our JS, so we cannot set a header on it.

Server-side, `_extract_cast_token_from_request` (`transcript_viewer.py:366`)
accepts `?rt=`, `X-Cast-Token`, or `Authorization: Bearer`.

### What a cast token is *not* allowed to do

`SESSION_ONLY_PATHS` (`transcript_viewer.py:84`) blocks cast tokens from
`/api/cast/session` and `/api/cast/debug`. Without this, a receiver token could
mint itself a fresh token forever, making the TTL meaningless.

### Media scope check

`media()` (`transcript_viewer.py:1069`) enforces, when
`CAST_TOKEN_REQUIRED_FOR_MEDIA=1`:

```
valid signature AND not expired AND (scope == '_auth' OR scope == filename stem)
```

---

## 4. Playback and transcript sync

### Why the sender plays a muted copy

While casting, the sender keeps its own `<audio>` playing **muted and in sync**
rather than paused. Its native `timeupdate` (~4 Hz) drives transcript
highlighting; polling `remotePlayer.currentTime` gives roughly 1 s granularity
plus network lag. A 500 ms interval (`app.js:726`) snaps the local element back
whenever drift exceeds 0.5 s.

This matches Google's Android TV guidance: "use media related events fired by
`<audio>/<video>` elements, like `timeupdate`, `pause` and `waiting`. Avoid using
networking related events like `progress`, `suspend` and `stalled`."

### RemotePlayer events we listen to

`setupCastSync` (`app.js:663`) uses `IS_PAUSED_CHANGED` and
`CURRENT_TIME_CHANGED`. The full `RemotePlayerEventType` enum also includes
`IS_CONNECTED_CHANGED`, `IS_MEDIA_LOADED_CHANGED`, `DURATION_CHANGED`,
`PLAYER_STATE_CHANGED`, `MEDIA_INFO_CHANGED` and others
([reference](https://developers.google.com/cast/docs/reference/web_sender/cast.framework)).
We deliberately ignore most; see audit finding **C-5** for the one that matters.

### The two load paths

**Sender picks an episode** → `loadCurrentEpisodeOnCastSession` (`app.js:614`)
mints an **episode-scoped** token, builds an absolute URL, and calls
`session.loadMedia()`.

**Receiver picks an episode on the TV** → `receiverEstablishMediaSession`
(`app.js:1181`) builds the same URL using its **`_auth`-scoped** token and calls
`playerManager.load()` with a synthetic `LoadRequestData`.

The receiver path must **not** simply set `audioEl.src`: the framework owns that
element via `setMediaElement`, and two competing loads produce
`MEDIA_ELEMENT_ERROR (104)` / `LOAD_FAILED (905)`. Related platform constraint:
"Cast devices support **one media element only**"
([core features](https://developers.google.com/cast/docs/web_receiver/core_features)).

Both paths pass `customData.episodeId`, which the `LOAD` interceptor
(`app.js:1058`) reads to load the matching transcript.

> Google "**strongly** recommends" the built-in `cast-media-player` element. We
> instead bind our own `<audio>` via `playerManager.setMediaElement(audioEl)`
> (`app.js:1025`) because we render a transcript UI, not a video surface. This is
> a supported API but a deviation from the recommended path — expect less help
> from the framework's default UI state handling.

---

## 5. Media requirements

- **MP3 is supported.** Containers include MP3; audio codecs include MP3; valid
  media type strings are `audio/mp3`, `audio/mpeg`, `audio/mpeg; codecs="mp3"`.
  We send `audio/mpeg`. ([supported media](https://developers.google.com/cast/docs/media))
- **CORS.** Required for adaptive streaming (HLS/DASH), and "even simple mp4
  media streams require CORS **if they include Tracks**". Allowed headers must
  cover `Content-Type`, `Accept-Encoding`, `Range`, and "**wildcards `*` cannot be
  used for `Access-Control-Allow-Origin`**" for protected content. echoai serves
  a plain progressive MP3 with no tracks, so **no CORS requirement is stated** for
  our case. ([advanced sender](https://developers.google.com/cast/docs/web_sender/advanced))
- **Byte-range / seeking.** The docs do **not** state a Range requirement;
  `Range` appears only in the CORS header list. In practice Flask's
  `send_from_directory` supports range requests, which is what makes seeking work.
- **GZIP.** "Android's media stack may use transparent GZIP … Make sure your
  media data can respond to `Accept-Encoding: gzip`."
- **Query strings and redirects on media URLs** — **not addressed in the docs**.
  Our `?rt=` token approach therefore rests on undocumented behaviour. It works,
  but it is not a guarantee Google has made.

---

## 6. Configuration checklist

| Setting | Where | Value |
|---|---|---|
| App ID | `TRANSCRIPT_VIEWER_CAST_RECEIVER_APP_ID` | from Cast Developer Console |
| Receiver URL | Cast Developer Console | `https://<public-host>/?mode=receiver` |
| Signing key | `TRANSCRIPT_VIEWER_CAST_SIGNING_KEY` | 64 hex chars, independent |
| Media enforcement | `TRANSCRIPT_VIEWER_CAST_TOKEN_REQUIRED_FOR_MEDIA` | `1` in production |
| Token TTL | `TRANSCRIPT_VIEWER_CAST_TOKEN_TTL_SECONDS` | `300` |
| Device serial | Cast Developer Console | required until the app is published |

---

## 7. Testing without deploying

Three tiers, in increasing cost. Do them in order.

### Tier 1 — no Chromecast, no network (seconds)

```bash
uv run pytest                          # includes the viewer smoke test
node --test tests/viewer/app.smoke.test.mjs   # or run it directly
```

`tests/viewer/app.smoke.test.mjs` executes the real `app.js` against a stub DOM
in a `node:vm` sandbox and asserts that it loads without a `ReferenceError`, that
`init()` is defined **and actually runs**, that the Cast entry points exist, and
that the `audioPlayer` / search / keyboard listeners are wired. It runs both
sender and receiver mode. `tests/test_viewer_smoke.py` invokes it so
`uv run pytest` remains the single command; it skips if `node` is absent.

This tier exists because commit `155f959` deleted `init()` and every audio
listener, and nothing noticed. That regression fails 5 of the 6 smoke assertions.

Also worth doing by hand:

- **Sender UI** — browse `http://localhost:5000`. Chrome treats `localhost` as a
  secure context, so the Cast SDK loads and the button appears. A blank page or a
  console error is your answer in one second.
- **Receiver UI** — browse `/?mode=receiver&rt=<token>&castDebug=1`. This renders
  the full receiver interface — fullscreen, episode picker, D-pad keys,
  transcript — in an ordinary tab, no device involved.
  `ensureAuthenticatedSession` accepts `rt` from the query string exactly for
  this. Mint a token with an authenticated `POST /api/cast/session {"episode_id":"_auth"}`.

What Tier 1 cannot cover: the Cast protocol itself. No session, no namespace, no
`RemotePlayer`, so C-4 and C-7 are unverified here.

### Tier 2 — real Chromecast on your LAN, still no deploy

This is the thorough one, and it works entirely off the Pi/Cloudflare path.

**1. Serve on a LAN address, not localhost.**

```bash
uv run python -m echoai.transcript_viewer --host 0.0.0.0 --port 5000
```

Find your machine's LAN IP (`ipconfig` / `ip addr`), e.g. `192.168.1.50`.

> **The single most common mistake:** browsing the *sender* at
> `http://localhost:5000`. `getCurrentEpisodeMeta` builds the media URL from
> `window.location.origin`, so the Chromecast is handed `http://localhost:5000/media/…`
> and resolves it to *itself*. Media silently fails to load. Browse the sender at
> `http://192.168.1.50:5000` too.

**2. Register a Custom Web Receiver.** In the
[Cast Developer Console](https://cast.google.com/publish): **Add New Application
→ Custom Receiver**, URL `http://192.168.1.50:5000/?mode=receiver`. HTTP is
explicitly allowed before publishing — but **not `localhost`**. Save and copy the
app ID.

**3. Register the device for development.** Same console, **Add New Device**,
enter the Chromecast's serial number (on the device, or cast the console page to
it). Then **wait 15 minutes** until it reads *Ready for Testing*, and power-cycle
the Chromecast. Nothing works before this — a correct integration looks completely
dead.

**4. Point the app at your receiver.**

```dotenv
TRANSCRIPT_VIEWER_CAST_RECEIVER_APP_ID=<your app id>
TRANSCRIPT_VIEWER_CAST_TOKEN_REQUIRED_FOR_MEDIA=1   # test the production path
TRANSCRIPT_VIEWER_COOKIE_SECURE=0                   # LAN test is plain HTTP
```

`COOKIE_SECURE=0` is required over HTTP or the session cookie is never stored.
Revert it for production. You can also override the app ID per-tab without
restarting: `?receiverAppId=XXXXXXXX`.

**5. Watch both sides.** Sender: Chrome DevTools console. Receiver: append
`&castDebug=1` to the receiver URL for the on-screen panel (long-press
Enter/Select for 1.6 s on the TV remote to toggle it), or attach the
[Chrome Remote Debugger](https://developers.google.com/cast/docs/debugging/remote_debugger)
at `http://<chromecast-ip>:9222` — available once the device is registered.

**6. The checks that matter.** These are the ones Tier 1 cannot reach:

| # | Test | Expected |
|---|---|---|
| 1 | Click Cast, pick the device | TV shows echoai's transcript UI, **not** a generic player (proves C-1: right app ID) |
| 2 | Receiver debug log right after connect | `ready` handshake sent, then `auth token stored` (C-4) |
| 3 | Play; watch the sender transcript | Highlight tracks the TV within ~0.5 s |
| 4 | **Reload the sender tab while casting** | Session resumes *and* the receiver keeps working past the next TTL — the C-7 regression |
| 5 | Pick a different episode **on the TV** (D-pad) | Audio plays; sender follows. Under `CAST_TOKEN_REQUIRED_FOR_MEDIA=1` this is the `_auth`-scope path that used to 403 |
| 6 | Seek near the end of a long episode | No 401/403 — the C-2 token TTL fix |
| 7 | Leave it casting for > 1 hour | Still playing; refresh loop held |
| 8 | Stop casting | Sender audio unmutes and continues locally |

### Tier 3 — needs the real deployment

Published-app HTTPS behaviour, the Cloudflare Tunnel path, TLS-terminated cookie
flags (`COOKIE_SECURE=1`), and real-network latency/drift tuning. No local
substitute.

---

## 8. Debugging

- **`?castDebug=1`** — echoai's own on-screen log panel. On the TV, long-press
  Enter/Select (1.6 s) to toggle it.
- **`GET /api/cast/debug`** — server-side view of signing-key presence, TTLs,
  session counts, resolved paths, and the CSP. Requires a logged-in session.
- **Chrome Remote Debugger** — `http://<chromecast-ip>:9222`, available once the
  device is registered for development
  ([remote debugger](https://developers.google.com/cast/docs/debugging/remote_debugger)).
- **CaC Tool** — Google's Command and Control tool for driving a receiver without
  writing a sender ([CaC](https://developers.google.com/cast/docs/debugging/cac_tool)).
- **Error codes** — [receiver error codes](https://developers.google.com/cast/docs/web_receiver/error_codes);
  `app.js` maps the common ones in `CAST_ERROR_CODE_NAMES`.

### Symptom → cause

| Symptom | Likely cause |
|---|---|
| No devices found | Sender not on HTTPS; different subnet; mDNS blocked |
| Cast connects, TV shows default player | App ID is the Default Media Receiver, not ours (**C-1**) |
| TV shows our page, transcript never loads | Auth token never arrived — check the namespace listener |
| Audio 401/403 mid-episode | Cast token expired; see **C-2** |
| `LOAD_FAILED (905)` / `MEDIA_ELEMENT_ERROR (104)` | Two competing loads on one media element |

---

## 9. Audit findings

Result of auditing `app.js` and `transcript_viewer.py` against the SDK contracts
above.

### Fixed

- **C-1 — Default Media Receiver fallback was silent.** With no app ID
  configured, the sender fell back to `CC1AD845` logging only a `WARN`. Audio
  would play while the transcript UI, episode picker, and auth channel were all
  absent, with no clear reason. Now logs `ERROR` naming the cause and the fix.
- **C-2 — token TTL was shorter than an episode.** Default was 300 s; the media
  URL given to the Chromecast embeds the token and is never rewritten, so a seek
  past ~5 minutes would 401 (403 before the scope fix). Default raised to 3 h.
- **C-3 — `sendMessage` rejection was unhandled.** `session.sendMessage` returns
  a Promise; a failed auth delivery vanished silently, presenting as an
  indefinitely blank TV. Now awaited and logged.
- **C-4 — auth delivery was a race.** The sender waited a fixed 500 ms and
  pushed once. If the receiver's listener was not yet registered, the token was
  lost until the next refresh tick — minutes of 401s. Added the receiver-driven
  `ready` handshake described in §3.
- **C-6 — SDK URLs hardcoded `https:`.** Google's stated best practice is to omit
  the protocol so the SDK is fetched over the page's scheme. Now protocol-relative.
- **C-7 — `SESSION_RESUMED` left the receiver unauthenticated.** On resume the
  handler called `setupCastSync`, which clears the token refresh timer, but never
  called `sendAuthToReceiver`. The timer was never restarted and no fresh token
  was sent, so the receiver's token expired and every request 401'd. This fires
  on any sender page reload while casting, which `ORIGIN_SCOPED` auto-join makes
  routine. Now re-issues the token and restarts the refresh loop.

### Open

- **C-8 — `?rt=` on media URLs is undocumented territory.** Google's docs say
  nothing about query strings or redirects on media URLs. It works today; it is
  not a guarantee.
- **C-9 — no `cast-media-player`.** We bind our own `<audio>` via
  `setMediaElement`, against Google's "strongly recommended" default. Justified
  by our transcript UI, but it is why the dual-load conflicts in §4 exist at all.
- **C-10 — receiver trusts `?rt=` from its own URL.** `ensureAuthenticatedSession`
  accepts a token from the receiver page's query string for browser testing. Same
  signed-token trust model, but it widens where a token can leak from (logs,
  referrers).

### Second pass

- **C-11 — CSP pinned `https://` on the Cast SDK hosts.** Once the SDK `<script>`
  URLs became protocol-relative (C-6), `script-src https://www.gstatic.com` no
  longer matched them on an `http://` origin, so the SDK was blocked outright —
  breaking exactly the Tier-2 LAN setup §7 prescribes. Host sources are now
  scheme-less, which matches the page's own scheme. **Fixed.**
- **C-12 — a pre-existing session at init was never wired up.** `initCastSender`
  assigned `castSession = context.getCurrentSession()` but called neither
  `setupCastSync` nor `_muteSenderForCast`. With `ORIGIN_SCOPED` auto-join the
  session can attach *before* the `SESSION_STATE_CHANGED` listener exists, so no
  event ever arrives to fix it: local audio played unmuted over the TV,
  `_isCasting()` stayed false so seeks never reached the receiver, and the token
  refresh loop never started. Both this and `SESSION_RESUMED` now go through one
  `_adoptCastSession()`. **Fixed.**
- **C-13 — no `IS_CONNECTED_CHANGED` handling** (was C-5). A receiver that dies
  without a clean `SESSION_ENDED` left the sender muted, holding a dead session
  and mirroring seeks into the void. Now tears down and unmutes. **Fixed.**
- **C-14 — word→segment mapping was rebuilt by string comparison.** The client
  re-derived which words belong to which segment by matching `word.context`
  against segment text; two segments with identical text (`"Ja genau."`) gave
  segment 0 all of segment 1's words and left segment 1 empty. The server now
  stamps `segment_index` on every word, with the old walk kept as a fallback.
  **Fixed**, covered by `test_words_are_stamped_with_their_segment`.
- **C-15 — `/api/episode` had no per-item isolation.** A segment with a
  non-numeric `avg_logprob`, or a `words` value that wasn't a list, raised
  through the loop and 500'd the whole episode. Now isolated per segment.
  **Fixed.**
- **C-16 — `low-confidence` never rendered.** The class is set on
  `.translatable-word` spans but was only styled as `.word.low-confidence`, a
  selector that matched nothing. **Fixed** with a matching rule.
- **C-17 — episode picker used `innerHTML` with filename-derived values.**
  `ep.id`/`ep.title` come from `audio_path.stem`, which is never validated
  against the episode-id charset. Now `textContent`. **Fixed.**
