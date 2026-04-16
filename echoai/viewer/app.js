// ═══════════════════════════════════════════════════════════════════════════════
// app.js — EchoAI Transcript Viewer (German Podcast Language Learning Tool)
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Interactive transcript viewer for German podcast episodes.  Displays
//   word-level and segment-level transcripts with audio synchronisation,
//   hover-to-translate (DE→EN via Google Translate), grammar analysis (spaCy),
//   and Chromecast support for casting audio to a TV/speaker while keeping
//   transcript tracking on the sender (browser).
//
// ── DUAL-MODE ARCHITECTURE ──────────────────────────────────────────────────
//
//   This single file runs in TWO modes, determined by the URL query string:
//
//   1. SENDER MODE (default)
//      - Normal browser tab.  User browses episodes, plays audio locally,
//        sees transcript tracking.  Can cast to a Chromecast.
//      - When casting: local audio is MUTED (not paused).  The muted local
//        <audio> element continues to play in sync with the receiver so its
//        native `timeupdate` event drives transcript highlighting.  The
//        sender's RemotePlayer + RemotePlayerController track the receiver's
//        media state (play/pause, seek, duration).
//
//   2. RECEIVER MODE (?mode=receiver)
//      - Loaded by the Chromecast device as a Custom Receiver app.
//      - Enters fullscreen immediately.  Shows transcript + episode picker.
//      - The Cast framework's `playerManager.setMediaElement(audioEl)` binds
//        the framework to OUR <audio> element, so LOAD/PLAY/PAUSE/SEEK
//        commands from the sender drive audioEl directly.
//      - Auth tokens arrive via a custom Cast namespace message from sender.
//
// ── CAST SYNCHRONISATION MODEL ──────────────────────────────────────────────
//
//   The key challenge: keep the sender's transcript highlighting in sync with
//   the receiver's audio playback across the Cast protocol's ~200-500ms latency.
//
//   Approach: the sender plays its own muted copy of the audio.  Its native
//   `timeupdate` event (fired by the browser's media pipeline) drives all
//   transcript highlighting — no polling of remotePlayer.currentTime for UI.
//   A 500ms drift-correction interval snaps the muted local audio to the
//   receiver's reported position when they diverge by more than 0.5s.
//
//   WHY NOT just poll remotePlayer.currentTime?
//   - RemotePlayer updates are asynchronous and coarse (~1s granularity).
//   - Using it directly for transcript tracking produces jerky, delayed updates.
//   - The local muted audio gives smooth, browser-native timeupdate (~4Hz).
//
//   SYNC EVENTS (sender side, in setupCastSync):
//   - IS_PAUSED_CHANGED: mirrors pause/play to local audioEl.
//     · On PAUSE: just pause local audio in place (don't snap time — avoids
//       visible backward jump from Cast event latency).
//     · On PLAY: resume local muted playback; drift correction aligns in 500ms.
//   - CURRENT_TIME_CHANGED: snaps local time on large drifts (>0.5s playing,
//     >2s paused) to catch deliberate seeks without causing flicker loops.
//   - 500ms setInterval: drift correction + autoplay-policy recovery.
//
// ── EPISODE LOADING ON RECEIVER ─────────────────────────────────────────────
//
//   When the RECEIVER's UI selects an episode (D-pad / episode picker):
//   1. receiverEstablishMediaSession(episodeId) is called — NOT loadEpisode().
//   2. This calls playerManager.load() with a synthetic LoadRequestData
//      containing the authenticated media URL and episodeId in customData.
//   3. The LOAD interceptor fires, calling loadEpisode(id, {skipAudioSrc:true})
//      to load the transcript without touching audioEl.src (the framework
//      handles that via setMediaElement).
//   4. notifySenderEpisodeChanged(episodeId) tells the sender to load the
//      transcript locally with skipCastLoad:true (don't LOAD back to receiver).
//
//   WHY NOT call loadEpisode() directly on the receiver?
//   - loadEpisode sets audioEl.src, which conflicts with the Cast framework's
//     own media loading (via setMediaElement).  The play() from loadEpisode
//     gets interrupted by the framework's load, causing MEDIA_ELEMENT_ERROR
//     (code 104) and LOAD_FAILED (code 905).
//
//   When the SENDER selects an episode while casting:
//   1. loadEpisode(id) runs normally (sets audioEl.src for muted local copy).
//   2. loadCurrentEpisodeOnCastSession() sends a LOAD to the receiver via
//      session.loadMedia() with an authenticated media URL + customData.
//   3. The receiver's LOAD interceptor fires, loading the transcript.
//
// ── AUTH MODEL ──────────────────────────────────────────────────────────────
//
//   - Sender: authenticated via session cookie (login prompt on first load).
//   - Receiver (Chromecast): no cookies.  Auth token sent via custom Cast
//     namespace message ("urn:x-cast:com.echoai.auth") immediately after
//     session start.  The token is refreshed at 80% of its TTL to prevent
//     401 errors on long-running sessions.
//   - The receiver stores the token in `receiverAuthToken` and attaches it
//     as an X-Cast-Token header on all fetchJson() calls, and as ?rt= on
//     media URLs.
//
// ── TRANSLATION LOADING ─────────────────────────────────────────────────────
//
//   Segment translations (DE→EN) are loaded lazily — only ±3 segments around
//   the currently playing segment.  This avoids overwhelming the single-threaded
//   Flask server (each translation hits Google Translate with a 6s timeout).
//   A re-entry guard (_translatingAroundCenter) prevents duplicate requests
//   from frequent timeupdate calls.
//
// ═══════════════════════════════════════════════════════════════════════════════

// ── DOM element references ───────────────────────────────────────────────────
const episodeListEl = document.getElementById("episodeList");
const statusTextEl = document.getElementById("statusText");
const searchInputEl = document.getElementById("searchInput");
const episodeTitleEl = document.getElementById("episodeTitle");
const audioEl = document.getElementById("audioPlayer");
const transcriptViewerEl = document.getElementById("transcriptViewer");
const syncHintEl = document.getElementById("syncHint");
const translationToggleBtnEl = document.getElementById("translationToggleBtn");
const castBtnEl = document.getElementById("castBtn");

const fsOverlayEl = document.getElementById("fsOverlay");
const fsProgressFillEl = document.getElementById("fsProgressBarFill");
const fsProgressTrackEl = document.getElementById("fsProgressBarTrack");
const fsTranscriptEl = document.getElementById("fsTranscript");
const fsExitBtnEl = document.getElementById("fsExitBtn");
const fullscreenBtnEl = document.getElementById("fullscreenBtn");
const receiverPrevBtnEl = document.getElementById("receiverPrevBtn");
const receiverToggleBtnEl = document.getElementById("receiverToggleBtn");
const receiverNextBtnEl = document.getElementById("receiverNextBtn");
const receiverEpisodesBtnEl = document.getElementById("receiverEpisodesBtn");
const fsEpisodePickerEl = document.getElementById("fsEpisodePicker");
const fsEpisodePickerListEl = document.getElementById("fsEpisodePickerList");
const fsEpisodePickerCloseBtnEl = document.getElementById("fsEpisodePickerCloseBtn");

// ── Mode detection from URL query parameters ─────────────────────────────────
// ?mode=receiver  → Chromecast receiver mode (fullscreen, no local controls)
// ?castDebug=1    → show live Cast debug log panel
// ?receiverAppId=XXXX → override Cast receiver app ID
const urlParams = new URLSearchParams(window.location.search);
const receiverMode = urlParams.get("mode") === "receiver" || urlParams.get("receiver") === "1";
const castDebugEnabled = urlParams.get("castDebug") === "1";

// ...existing code... (Cast Debug Logger section stays as-is)

// ── Application state ────────────────────────────────────────────────────────
let episodes = [];                    // Full episode list from /api/episodes
let filteredEpisodes = [];            // Filtered by search input
let currentEpisodeId = null;          // Currently loaded episode ID
let currentSegments = [];             // Transcript segments [{start, end, text, translation_en}]
let currentWords = [];                // Word-level tokens [{word, start, end, probability, context}]
let segmentWordRanges = [];           // Maps segment index → {start, end} indices into currentWords
let activeSegmentIndex = -1;          // Currently highlighted segment in normal view
let activeWordIndex = -1;             // Currently highlighted word in normal view
let translationsVisible = true;       // Whether EN translation captions are shown

// ── Fullscreen / receiver UI state ───────────────────────────────────────────
let isFullscreen = false;             // Whether fullscreen overlay is active
let fsActiveSegmentIndex = -1;        // Currently highlighted segment in fullscreen
let fsActiveWordIndex = -1;           // Currently highlighted word in fullscreen
const translationCache = new Map();   // Word translation cache (word||context → {display, translation})
const segmentTranslationCache = new Map(); // Segment translation cache (text → translation)
let hoverTimer = null;                // Debounce timer for word hover tooltip
let hideTimer = null;                 // Delay timer for tooltip hide
let activeEpisodeLoadToken = 0;       // Monotonic token to cancel stale loadEpisode() calls
let isFsEpisodePickerOpen = false;    // Whether the fullscreen episode picker overlay is open
let fsEpisodePickerIndex = -1;        // Currently highlighted episode in the picker

// ── Cast state (sender side) ─────────────────────────────────────────────────
let castSession = null;               // Active CastSession (set by SESSION_STATE_CHANGED)
let isCastReady = false;              // Whether the Cast SDK has initialized
let runtimeConfig = {};               // Server config from /api/config
const CAST_NAMESPACE = "urn:x-cast:com.echoai.auth"; // Custom namespace for auth + episode messages

// ── Cast state (receiver side) ───────────────────────────────────────────────
let receiverAuthToken = null;         // Auth token received from sender via Cast namespace
let receiverPlayerManager = null;     // Cast PlayerManager instance (receiver only)

// ── Bidirectional Cast sync state (sender side) ──────────────────────────────
// These are only used on the sender to track the receiver's media state.
let remotePlayer = null;              // cast.framework.RemotePlayer — tracks receiver state
let remotePlayerController = null;    // cast.framework.RemotePlayerController — sends commands
let castTimeSyncInterval = null;      // 500ms drift correction interval ID
let castTokenRefreshInterval = null;  // Periodic auth token refresh interval ID

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether we have an active Cast session.  Uses `castSession` (set reliably
 * by SESSION_STATE_CHANGED) rather than `remotePlayer.isConnected` which can
 * lag behind or require media to be loaded first.
 *
 * IMPORTANT: On the receiver, castSession and remotePlayerController are always
 * null — _isCasting() always returns false on the receiver.  This is correct:
 * the receiver doesn't "cast to itself".  Functions like _seekTo() and
 * togglePlayPause() use _isCasting() to decide whether to mirror actions to
 * the Chromecast, which only makes sense on the sender.
 */
function _isCasting() {
  return !!(castSession && remotePlayerController);
}

/**
 * Seek to a time position.  When casting, seek both:
 * 1. The local (muted) audioEl — drives transcript tracking via timeupdate.
 * 2. The Chromecast receiver — via remotePlayerController.seek().
 *
 * On the receiver, _isCasting() is false, so only audioEl is seeked directly.
 * The Cast framework (which owns audioEl via setMediaElement) then reports the
 * new position to the sender's RemotePlayer.
 *
 * @param {number} time - Seek target in seconds.
 * @param {boolean} autoPlay - If true, also start playback if paused.
 */
function _seekTo(time, autoPlay = true) {
  audioEl.currentTime = time;
  if (autoPlay && audioEl.paused) {
    audioEl.play().catch((err) => {
      castLog("WARN", "_seekTo play failed:", err.message);
    });
  }
  if (_isCasting()) {
    castLog("INFO", "_seekTo → Chromecast:", time.toFixed(1), "s, autoPlay:", autoPlay);
    remotePlayer.currentTime = time;
    remotePlayerController.seek();
    // When the user clicks a segment to play from that position, also resume
    // the remote if it was paused — otherwise the local muted audio advances
    // while the remote stays still, and the 500ms drift correction keeps snapping
    // the local position back, creating a janky loop.
    if (autoPlay && remotePlayer.isPaused) {
      remotePlayerController.playOrPause();
    }
  }
}

/** Mute the sender's local audio element when a Cast session starts. */
function _muteSenderForCast() {
  if (receiverMode) return;
  audioEl.muted = true;
  castLog("INFO", "sender audio muted for casting");
}

/** Unmute the sender's local audio element when casting ends. */
function _unmuteSenderForCast() {
  if (receiverMode) return;
  audioEl.muted = false;
  castLog("INFO", "sender audio unmuted — casting ended");
}

/**
 * Ensure the sender's local audio is playing muted so that its native
 * `timeupdate` event drives transcript tracking and the HTML5 player UI
 * shows the correct time position.
 *
 * WHY MUTED PLAYBACK instead of pausing + polling?
 * - The browser's native timeupdate fires at ~4Hz with sub-100ms accuracy.
 * - Polling remotePlayer.currentTime gives ~1s granularity with network lag.
 * - Muted playback is zero-cost (decoded but not sent to speakers).
 *
 * Safe to call repeatedly — no-ops if already playing.
 */
function _ensureLocalMutedPlayback() {
  if (receiverMode) return;
  if (!audioEl.src) return;
  audioEl.muted = true;
  if (audioEl.paused) {
    audioEl.play().catch((err) => {
      castLog("WARN", "_ensureLocalMutedPlayback failed:", err.message);
    });
  }
}

// In receiver mode, strip native audio controls and remove from tab order so
// the Google TV D-pad can never focus the browser's built-in media player UI.
if (receiverMode) {
  audioEl.removeAttribute("controls");
  audioEl.tabIndex = -1;
  audioEl.style.pointerEvents = "none";
}

castLog("INFO", "app.js loaded — receiverMode:", receiverMode, "castDebug:", castDebugEnabled);
castLog("INFO", "userAgent:", navigator.userAgent.substring(0, 120));
castLog("INFO", "location:", window.location.href);

const tooltipEl = document.createElement("div");
tooltipEl.id = "translateTooltip";
tooltipEl.className = "translate-tooltip hidden";
tooltipEl.innerHTML = `
  <div id="tooltipText" class="tooltip-text"></div>
  <button id="tooltipExplainBtn" class="tooltip-explain-btn" type="button">Explain to me</button>
`;
document.body.appendChild(tooltipEl);

const tooltipTextEl = document.getElementById("tooltipText");
const tooltipExplainBtnEl = document.getElementById("tooltipExplainBtn");
let tooltipWord = "";
let tooltipContext = "";

function formatTime(seconds) {
  // Clamp to non-negative, floor to whole seconds, format as HH:MM:SS or MM:SS.
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

async function fetchJson(url) {
  // Attach Cast auth token header when running on receiver (no cookies available).
  const headers = {};
  if (receiverAuthToken) {
    headers["X-Cast-Token"] = receiverAuthToken;
  }
  castLog("INFO", "fetchJson →", url, receiverAuthToken ? "(cast-token)" : "(no token)");
  const res = await fetch(url, { headers });
  if (!res.ok) {
    castLog("ERROR", "fetchJson failed:", url, "status:", res.status, res.statusText);
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

function getCastReceiverAppId() {
  // Priority: URL query param > localStorage override > server config > default.
  // The default CC1AD845 is Google's Default Media Receiver (for testing only).
  const fromQuery = new URLSearchParams(window.location.search).get("receiverAppId");
  if (fromQuery) { castLog("INFO", "appId from query:", fromQuery); return fromQuery; }
  const fromStorage = localStorage.getItem("castReceiverAppId");
  if (fromStorage) { castLog("INFO", "appId from localStorage:", fromStorage); return fromStorage; }
  if (runtimeConfig.cast_receiver_app_id) { castLog("INFO", "appId from config:", runtimeConfig.cast_receiver_app_id); return runtimeConfig.cast_receiver_app_id; }
  castLog("WARN", "using default Cast appId CC1AD845");
  return "CC1AD845"; // Default Media Receiver fallback
}

async function ensureAuthenticatedSession() {
  // Receiver mode: auth comes via Cast namespace message, not cookies.
  // In browser testing (?mode=receiver), a query-string token can be used instead.
  if (receiverMode) {
    const tokenFromQuery = new URLSearchParams(window.location.search).get("rt");
    if (tokenFromQuery) {
      receiverAuthToken = tokenFromQuery;
      castLog("INFO", "receiver auth: token from query string");
      return;
    }
    // No token yet — receiver will wait for Cast message in initCastReceiver.
    castLog("INFO", "receiver auth: no query token, waiting for Cast namespace message");
    return;
  }

  castLog("INFO", "ensureAuthenticatedSession: checking /api/auth/status");
  const statusRes = await fetch("/api/auth/status");
  if (!statusRes.ok) {
    castLog("ERROR", "auth status check failed:", statusRes.status);
    throw new Error(`Auth status failed: ${statusRes.status}`);
  }

  const status = await statusRes.json();
  if (status.authenticated) {
    castLog("INFO", "already authenticated");
    return;
  }

  castLog("INFO", "not authenticated — prompting for credentials");
  const username = globalThis.prompt("Username", status.username_hint || "") || "";
  const password = globalThis.prompt("Password", "") || "";
  if (!username || !password) {
    castLog("WARN", "login cancelled by user");
    throw new Error("Login canceled.");
  }

  castLog("INFO", "attempting login for user:", username);
  const loginRes = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!loginRes.ok) {
    castLog("ERROR", "login failed:", loginRes.status);
    throw new Error(`Login failed: ${loginRes.status}`);
  }
  castLog("OK", "login succeeded");
}

async function requestCastSessionToken(episodeId) {
  castLog("INFO", "requestCastSessionToken for:", episodeId);
  const response = await fetch("/api/cast/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episode_id: episodeId }),
  });

  if (!response.ok) {
    castLog("ERROR", "cast session token request failed:", response.status);
    throw new Error(`Cast token request failed: ${response.status}`);
  }
  const data = await response.json();
  castLog("OK", "cast session token received — expires_at:", data.expires_at || "unknown");
  return data.token || null;
}

async function loadRuntimeConfig() {
  try {
    runtimeConfig = await fetchJson('/api/config');
    castLog("INFO", "runtimeConfig loaded:", runtimeConfig);
    if (runtimeConfig.version) {
      const versionEl = document.getElementById("appVersion");
      if (versionEl) versionEl.textContent = `v${runtimeConfig.version}`;
    }
  } catch (err) {
    castLog("WARN", "runtimeConfig load failed:", err.message);
    runtimeConfig = {};
  }
}

function updateCastButtonState() {
  // Sync the Cast button's visibility and label with the current Cast state.
  // Hidden until the Cast SDK has initialized (device discovery is async).
  if (!castBtnEl) return;
  if (!isCastReady) {
    castBtnEl.classList.add("hidden");
    castLog("INFO", "castBtn hidden — SDK not ready");
    return;
  }

  const connected = !!castSession;
  const context = cast.framework.CastContext.getInstance();
  const castState = context.getCastState();

  castBtnEl.classList.remove("hidden");
  castBtnEl.classList.toggle("connected", connected);

  if (connected) {
    castBtnEl.textContent = "Casting";
  } else if (castState === cast.framework.CastState.NOT_CONNECTED) {
    castBtnEl.textContent = "Cast";
  } else if (castState === cast.framework.CastState.NO_DEVICES_AVAILABLE) {
    castBtnEl.textContent = "Cast";
  } else {
    castBtnEl.textContent = "Cast";
  }

  castLog("INFO", "castBtn updated — connected:", connected, "castState:", castState);
}

function getCurrentEpisodeMeta() {
  // Build an absolute media URL for the current episode — Chromecast needs
  // a full URL since it loads media from its own network stack (no cookies).
  if (!currentEpisodeId) return null;
  const ep = episodes.find((item) => item.id === currentEpisodeId);
  if (!ep) return null;

  // Use absolute URL so Chromecast receiver can fetch media from this server.
  const mediaUrl = `${window.location.origin}${ep.audio}`;
  return {
    id: ep.id,
    title: ep.title,
    mediaUrl,
  };
}

async function loadCurrentEpisodeOnCastSession(session, startTime = 0) {
  // Called by the SENDER to load media on the Chromecast.  Appends a short-lived
  // auth token to the media URL since the receiver can't use session cookies.
  const meta = getCurrentEpisodeMeta();
  if (!meta) { castLog("WARN", "loadCurrentEpisodeOnCastSession: no episode meta"); return; }

  castLog("INFO", "loading media on Cast session:", meta.id, meta.mediaUrl, "startTime:", startTime);

  let mediaUrl = meta.mediaUrl;
  try {
    const token = await requestCastSessionToken(meta.id);
    if (token) {
      mediaUrl = `${meta.mediaUrl}${meta.mediaUrl.includes("?") ? "&" : "?"}rt=${encodeURIComponent(token)}`;
      castLog("INFO", "cast token appended to media URL");
    }
  } catch (err) {
    castLog("ERROR", "cast token request failed:", err.message);
    statusTextEl.textContent = err.message;
    return;
  }

  const mediaInfo = new chrome.cast.media.MediaInfo(mediaUrl, "audio/mpeg");
  const md = new chrome.cast.media.GenericMediaMetadata();
  md.title = meta.title;
  md.subtitle = meta.id;
  mediaInfo.metadata = md;
  mediaInfo.customData = {
    episodeId: meta.id,
    startTime,
  };

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.currentTime = startTime;
  request.autoplay = true;

  castLog("INFO", "sending LoadRequest — currentTime:", request.currentTime);
  session.loadMedia(request,
    () => { castLog("OK", "media loaded successfully on receiver"); },
    (err) => { castLog("ERROR", "loadMedia failed:", err); }
  );
}

// ── Bidirectional Cast sync helpers ──────────────────────────────────────────

/**
 * Set up RemotePlayer + RemotePlayerController so the sender tracks receiver
 * media state (play/pause, seek).  Also listens for custom namespace messages
 * (episode changes) from the receiver.
 */
function setupCastSync(session) {
  teardownCastSync();

  if (!window.cast || !window.cast.framework) return;

  remotePlayer = new cast.framework.RemotePlayer();
  remotePlayerController = new cast.framework.RemotePlayerController(remotePlayer);
  castLog("INFO", "RemotePlayer + Controller created");

  // Kick-start local muted playback so the sender UI tracks position from
  // the moment casting begins — don't wait for IS_PAUSED_CHANGED which may
  // not fire until the Chromecast finishes loading media.
  _ensureLocalMutedPlayback();

  // Mirror remote play/pause to local audioEl — the local element plays muted
  // so its timeupdate event drives transcript tracking naturally.
  remotePlayerController.addEventListener(
    cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
    () => {
      castLog("INFO", "remote IS_PAUSED_CHANGED — paused:", remotePlayer.isPaused);
      if (remotePlayer.isPaused) {
        // Just pause — don't snap audioEl.currentTime.  The local audio
        // will be at most ~0.5s ahead (the Cast event latency).  Snapping
        // back causes a visible transcript jump.  The drift correction
        // will re-align when playback resumes.
        audioEl.pause();
      } else {
        // Resume local muted playback.  Don't snap audioEl.currentTime here —
        // remotePlayer.currentTime often still reports the stale paused value
        // at this moment, which causes the transcript to hang at the old
        // position then skip forward once CURRENT_TIME_CHANGED catches up.
        // The drift correction interval will align within ~500ms.
        _ensureLocalMutedPlayback();
      }
    }
  );

  // On discrete receiver-side seeks, snap local audioEl to match.
  // When paused, only snap on large jumps (>2s) to catch deliberate seeks
  // while avoiding the flicker loop from repeated small snaps.
  remotePlayerController.addEventListener(
    cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
    () => {
      if (remotePlayer.duration <= 0) return;
      const drift = Math.abs(audioEl.currentTime - remotePlayer.currentTime);
      if (remotePlayer.isPaused) {
        // Large jump while paused = deliberate seek on receiver.
        if (drift > 2) {
          audioEl.currentTime = remotePlayer.currentTime;
        }
        return;
      }
      if (drift > 0.5) {
        audioEl.currentTime = remotePlayer.currentTime;
      }
    }
  );

  // Lightweight drift correction — the local muted audioEl may drift slightly
  // from the receiver over time.  Every 500ms, snap it back if drift exceeds 0.5s.
  // Only corrects while the remote is playing to avoid flicker when paused.
  // Also recovers from the edge case where local playback was rejected the
  // first time (e.g. browser autoplay policy) — retries play() each cycle.
  castTimeSyncInterval = setInterval(() => {
    if (!_isCasting()) return;
    if (remotePlayer.isPaused) return;
    // If remote is playing but local is paused, restart local muted playback.
    if (audioEl.paused) {
      castLog("INFO", "drift interval: remote playing but local paused — restarting");
      _ensureLocalMutedPlayback();
    }
    const drift = Math.abs(audioEl.currentTime - remotePlayer.currentTime);
    if (drift > 0.5 && remotePlayer.duration > 0) {
      castLog("INFO", "drift correction:", drift.toFixed(1), "s");
      audioEl.currentTime = remotePlayer.currentTime;
    }
  }, 500);

  // Listen for custom namespace messages from the receiver (e.g. episode changes).
  session.addMessageListener(CAST_NAMESPACE, (_namespace, messageStr) => {
    try {
      const msg = typeof messageStr === "string" ? JSON.parse(messageStr) : messageStr;
      castLog("INFO", "sender received Cast message — type:", msg.type);
      if (msg.type === "episodeChanged" && msg.episodeId) {
        // If the sender already initiated this episode change, the receiver
        // is just echoing it back.  Ignore to avoid cancelling the sender's
        // in-progress loadEpisode (which would kill transcript rendering).
        if (msg.episodeId === currentEpisodeId) {
          castLog("INFO", "sender already on episode:", msg.episodeId, "— ignoring echo");
          return;
        }
        castLog("INFO", "receiver changed episode to:", msg.episodeId);
        // Load transcript + audio locally but do NOT send a LOAD back to the
        // receiver — it already has the episode loaded.  The sender plays
        // its local audioEl muted for transcript tracking independently.
        loadEpisode(msg.episodeId, { skipCastLoad: true });
      }
    } catch (err) {
      castLog("ERROR", "sender Cast message parse error:", err.message);
    }
  });

  castLog("OK", "Cast bidirectional sync established");
}

/** Tear down RemotePlayerController and stop the periodic time sync. */
function teardownCastSync() {
  if (castTimeSyncInterval) {
    clearInterval(castTimeSyncInterval);
    castTimeSyncInterval = null;
  }
  if (castTokenRefreshInterval) {
    clearInterval(castTokenRefreshInterval);
    castTokenRefreshInterval = null;
  }
  remotePlayer = null;
  remotePlayerController = null;
  castLog("INFO", "Cast sync torn down");
}

function initCastSender() {
  if (!castBtnEl) { castLog("WARN", "initCastSender: castBtnEl not found"); return; }
  castLog("INFO", "initCastSender called");

  function onCastApiReady() {
    castLog("INFO", "onCastApiReady — window.cast:", !!window.cast,
            "framework:", !!(window.cast && window.cast.framework));
    if (!window.cast || !window.cast.framework) {
      castLog("WARN", "onCastApiReady: framework not available");
      return;
    }
    if (isCastReady) { castLog("INFO", "onCastApiReady: already initialized, skipping"); return; }

    const appId = getCastReceiverAppId();
    castLog("INFO", "setting Cast options — appId:", appId, "autoJoinPolicy: ORIGIN_SCOPED");
    const context = cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: appId,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });

    isCastReady = true;
    castSession = context.getCurrentSession() || null;
    castLog("INFO", "Cast SDK ready — existing session:", !!castSession);
    castLog("INFO", "initial castState:", context.getCastState());
    updateCastButtonState();

    // Track device availability changes — discovery is async and can take seconds.
    context.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
      castLog("INFO", "CAST_STATE_CHANGED:", event.castState);
      updateCastButtonState();
    });

    context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
      castLog("INFO", "SESSION_STATE_CHANGED:", event.sessionState);
      const activeStates = [
        cast.framework.SessionState.SESSION_STARTING,
        cast.framework.SessionState.SESSION_STARTED,
        cast.framework.SessionState.SESSION_RESUMED,
      ];

      castSession = activeStates.includes(event.sessionState)
        ? context.getCurrentSession()
        : null;

      castLog("INFO", "session active:", !!castSession, "state:", event.sessionState);
      updateCastButtonState();

      if (event.sessionState === cast.framework.SessionState.SESSION_STARTED && castSession) {
        castLog("OK", "new Cast session started — sending auth + loading media");
        _muteSenderForCast();
        setupCastSync(castSession);
        void sendAuthToReceiver(castSession);
        void loadCurrentEpisodeOnCastSession(castSession, audioEl.currentTime || 0);
      }
      if (event.sessionState === cast.framework.SessionState.SESSION_RESUMED && castSession) {
        castLog("OK", "Cast session resumed — restoring sync");
        _muteSenderForCast();
        setupCastSync(castSession);
      }
      if (event.sessionState === cast.framework.SessionState.SESSION_ENDED) {
        castLog("INFO", "Cast session ended");
        teardownCastSync();
        _unmuteSenderForCast();
      }
    });
  }

  // Chrome's built-in Cast extension may have already loaded the framework.
  // Only inject cast_sender.js manually if it hasn't.
  if (window.cast && window.cast.framework) {
    castLog("INFO", "Cast framework already present (Chrome extension) — using it directly");
    onCastApiReady();
  } else {
    // Register callback for when Cast SDK loads — only needed when loading dynamically.
    window.__onGCastApiAvailable = function (isAvailable) {
      castLog("INFO", "__onGCastApiAvailable fired — isAvailable:", isAvailable);
      if (isAvailable) onCastApiReady();
    };
    castLog("INFO", "Cast framework not present — loading cast_sender.js dynamically");
    const script = document.createElement("script");
    script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
    script.async = true;
    script.addEventListener("load", () => { castLog("INFO", "cast_sender.js loaded"); });
    script.addEventListener("error", (e) => { castLog("ERROR", "cast_sender.js load FAILED", e.message || ""); });
    document.head.appendChild(script);
  }

  castBtnEl.addEventListener("click", async () => {
    castLog("INFO", "castBtn clicked — isCastReady:", isCastReady,
            "cast:", !!window.cast, "framework:", !!(window.cast && window.cast.framework));
    if (!isCastReady || !window.cast || !window.cast.framework) {
      castLog("WARN", "castBtn click ignored — SDK not ready");
      return;
    }

    const context = cast.framework.CastContext.getInstance();
    const castState = context.getCastState();
    castLog("INFO", "castState:", castState, "sessionState:", context.getSessionState());

    const existing = context.getCurrentSession();
    if (existing) {
      castLog("INFO", "ending existing session");
      existing.endSession(true);
      castSession = null;
      updateCastButtonState();
      return;
    }

    if (castState === cast.framework.CastState.NO_DEVICES_AVAILABLE) {
      castLog("WARN", "no Cast devices discovered yet — requesting session anyway (Chrome may prompt)");
    }

    try {
      castLog("INFO", "requesting new Cast session...");
      await context.requestSession();
      castLog("OK", "requestSession resolved — session:", !!context.getCurrentSession());
      // Session setup (mute, sync, auth, media load) is handled by the
      // SESSION_STATE_CHANGED → SESSION_STARTED handler above.
    } catch (err) {
      const code = err && (err.code || "");
      const desc = err && (err.description || err.message || String(err));
      castLog("WARN", "requestSession failed — code:", code, "description:", desc);

      if (code === "cancel") {
        castLog("INFO", "user cancelled the Cast device picker");
      } else if (castState === cast.framework.CastState.NO_DEVICES_AVAILABLE) {
        castLog("ERROR", "no Cast devices found. Ensure: (1) Chromecast is on the same network, " +
                "(2) receiver app " + getCastReceiverAppId() + " is published or device is registered for development, " +
                "(3) Chrome has Cast support enabled");
        statusTextEl.textContent = "No Cast devices found on your network.";
      }
    }
  });
}

async function sendAuthToReceiver(session) {
  // Brief delay lets the receiver finish initializing its Cast context and
  // namespace listener before we send the token message.
  castLog("INFO", "sendAuthToReceiver: waiting 500ms for receiver startup...");
  await new Promise((r) => setTimeout(r, 500));
  const ttl = await _mintAndSendCastToken(session);
  _startCastTokenRefresh(session, ttl);
}

/** Mint a fresh cast token and send it to the receiver. */
async function _mintAndSendCastToken(session) {
  try {
    castLog("INFO", "requesting auth token for receiver (episode_id=_auth)");
    const response = await fetch("/api/cast/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episode_id: "_auth" }),
    });
    if (!response.ok) {
      castLog("ERROR", "auth token request failed:", response.status);
      return 0;
    }
    const data = await response.json();
    if (data.token) {
      castLog("INFO", "sending auth token to receiver via namespace:", CAST_NAMESPACE);
      session.sendMessage(CAST_NAMESPACE, JSON.stringify({ type: "auth", token: data.token }));
      castLog("OK", "auth token sent to receiver, ttl:", data.token_ttl_seconds || "unknown");
      return data.token_ttl_seconds || 300;
    } else {
      castLog("WARN", "auth token response had no token");
    }
  } catch (err) {
    castLog("ERROR", "_mintAndSendCastToken error:", err.message || err);
  }
  return 0;
}

/** Periodically refresh the cast token before it expires. */
function _startCastTokenRefresh(session, ttlSeconds) {
  if (castTokenRefreshInterval) clearInterval(castTokenRefreshInterval);
  // Refresh at 80% of the TTL (default 300s → every 240s).
  const effectiveTtl = (ttlSeconds && ttlSeconds > 30) ? ttlSeconds : 300;
  const refreshMs = (effectiveTtl * 0.8) * 1000;
  castLog("INFO", "cast token refresh scheduled every", (refreshMs / 1000).toFixed(0), "s");
  castTokenRefreshInterval = setInterval(async () => {
    if (!_isCasting()) return;
    castLog("INFO", "periodic cast token refresh");
    await _mintAndSendCastToken(session);
  }, refreshMs);
}

// Map Cast DetailedErrorCode numbers to readable names for debug logging.
const CAST_ERROR_CODE_NAMES = {
  100: "MEDIA_UNKNOWN",
  101: "MEDIA_ABORTED",
  102: "MEDIA_DECODE",
  103: "MEDIA_NETWORK",
  104: "MEDIA_SRC_NOT_SUPPORTED",
  110: "SOURCE_BUFFER_FAILURE",
  111: "MEDIAKEYS_UNKNOWN",
  112: "MEDIAKEYS_NETWORK",
  113: "MEDIAKEYS_UNSUPPORTED",
  200: "SEGMENT_UNKNOWN",
  201: "SEGMENT_NETWORK",
  301: "HLS_NETWORK_MASTER_PLAYLIST",
  302: "HLS_NETWORK_PLAYLIST",
  303: "HLS_NETWORK_NO_KEY_RESPONSE",
  304: "HLS_NETWORK_KEY_LOAD",
  311: "HLS_SEGMENT_PARSING",
  900: "BREAK_CLIP_LOADING_ERROR",
  901: "BREAK_SEEK_INTERCEPTOR_ERROR",
  903: "IMAGE_ERROR",
  904: "LOAD_INTERRUPTED",
  905: "LOAD_FAILED",
  906: "MEDIA_ERROR_MESSAGE",
  907: "GENERIC",
};

function _castErrorName(code) {
  if (code == null || code === "") return "UNKNOWN";
  return CAST_ERROR_CODE_NAMES[code] || `CODE_${code}`;
}

function initCastReceiver() {
  // The Cast Receiver SDK is loaded by the Chromecast device itself — it may
  // not be available immediately when this function first runs.  We retry
  // with a 200ms delay until the SDK appears.
  castLog("INFO", "initCastReceiver called");
  const castReceiverContext = window.cast && window.cast.framework &&
    window.cast.framework.CastReceiverContext;

  if (!castReceiverContext) {
    castLog("WARN", "CastReceiverContext not available yet — retrying in 200ms");
    setTimeout(initCastReceiver, 200);
    return;
  }

  castLog("OK", "CastReceiverContext found — initializing receiver");
  const context = castReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  receiverPlayerManager = playerManager;

  // Tell the Cast framework to use OUR <audio> element instead of creating
  // its own.  This eliminates the dual-media-element conflict that caused
  // LOAD_FAILED (104) and GENERIC (905) errors — the framework tried to
  // load media in a separate element while our code drove audioEl.
  playerManager.setMediaElement(audioEl);
  castLog("INFO", "playerManager.setMediaElement bound to audioEl");

  // Listen for auth token from sender via custom namespace.
  // The sender calls sendAuthToReceiver() ~500ms after session start.
  // Until the token arrives, all fetchJson() calls will lack the header
  // and return 401 — this is expected and handled gracefully.
  context.addCustomMessageListener(CAST_NAMESPACE, (event) => {
    castLog("INFO", "received custom message on namespace:", CAST_NAMESPACE);
    try {
      const msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      castLog("INFO", "custom message parsed — type:", msg.type, "hasToken:", !!msg.token);
      if (msg.type === "auth" && msg.token) {
        receiverAuthToken = msg.token;
        castLog("OK", "auth token stored — loading episodes");
        loadEpisodesForReceiver();
        // If a LOAD already fired before auth arrived, the transcript fetch
        // would have failed (no token → 401).  Re-load the episode now that
        // we have the token so the transcript is displayed.
        if (currentEpisodeId) {
          castLog("INFO", "re-loading current episode after auth:", currentEpisodeId);
          loadEpisode(currentEpisodeId, { skipAudioSrc: true });
        }
      }
    } catch (err) {
      castLog("ERROR", "custom message parse error:", err.message);
    }
  });

  // When media is loaded, extract episode info from customData and load
  // transcript data.  The framework handles setting audioEl.src from the
  // request's contentUrl (which includes the auth token) — loadEpisode()
  // skips setting audioEl.src in receiver mode to avoid overwriting it.
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, (request) => {
    castLog("INFO", "LOAD interceptor fired — contentUrl:", (request.media && request.media.contentUrl) || "(none)");
    const customData = request.media && request.media.customData;
    if (customData && customData.episodeId) {
      castLog("INFO", "loading transcript for episode:", customData.episodeId);
      loadEpisode(customData.episodeId, { skipAudioSrc: true })
        .catch((err) => { castLog("ERROR", "loadEpisode from LOAD interceptor failed:", err.message); });
    } else {
      castLog("WARN", "LOAD request had no customData.episodeId");
    }
    return request;
  });

  playerManager.addEventListener(cast.framework.events.EventType.ERROR, (event) => {
    const code = event.detailedErrorCode;
    const name = _castErrorName(code);
    const reason = event.reason || "";
    castLog("ERROR", `receiver playerManager error: ${code} (${name})`, reason);
  });

  // Start the receiver with our custom settings:
  // - disableIdleTimeout: prevent Chromecast from closing the app after inactivity
  // - touchScreenOptimizedApp: suppress the default Cast media overlay
  // - autoResumeDuration: 0 means don't auto-resume from previous session
  castLog("INFO", "starting CastReceiverContext with namespace:", CAST_NAMESPACE);
  const options = new cast.framework.CastReceiverOptions();
  options.customNamespaces = {};
  options.customNamespaces[CAST_NAMESPACE] = cast.framework.system.MessageType.JSON;
  options.disableIdleTimeout = true;
  // Tell the framework we have our own UI — don't show the default media
  // controls overlay on Google TV / touch-enabled Cast devices.
  options.touchScreenOptimizedApp = true;
  options.playbackConfig = new cast.framework.PlaybackConfig();
  options.playbackConfig.autoResumeDuration = 0;
  context.start(options);
  castLog("OK", "CastReceiverContext started");

  // Transport interceptors — the framework drives audioEl directly via
  // setMediaElement, so we only log here (no manual audioEl.pause() etc.).
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.PAUSE, (requestData) => {
    castLog("INFO", "remote PAUSE command received");
    return requestData;
  });
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.PLAY, (requestData) => {
    castLog("INFO", "remote PLAY command received");
    return requestData;
  });
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.SEEK, (requestData) => {
    if (requestData && requestData.currentTime !== undefined) {
      castLog("INFO", "remote SEEK command:", requestData.currentTime);
    }
    return requestData;
  });

  // Ensure our page has focus so keydown events from the remote reach us.
  document.body.setAttribute("tabindex", "-1");
  document.body.focus();

  // Log receiver system events.
  context.addEventListener(cast.framework.system.EventType.READY, () => {
    castLog("OK", "receiver READY event");
  });
  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, (event) => {
    castLog("OK", "sender connected:", event.senderId || "");
  });
  context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, (event) => {
    castLog("INFO", "sender disconnected:", event.senderId || "", "reason:", event.reason || "");
  });
  context.addEventListener(cast.framework.system.EventType.ERROR, (event) => {
    const code = event.detailedErrorCode;
    const name = _castErrorName(code);
    castLog("ERROR", `receiver system error: ${code} (${name})`, event.reason || "");
  });
  context.addEventListener(cast.framework.system.EventType.SHUTDOWN, () => {
    castLog("INFO", "receiver shutdown");
  });
}


/**
 * Notify the connected sender that the receiver changed episodes.
 * Only sends when running as a Cast receiver with an active sender connection.
 */
function notifySenderEpisodeChanged(episodeId) {
  // Receiver → sender notification via the custom Cast namespace.
  // The sender's setupCastSync() message listener picks this up and calls
  // loadEpisode(id, { skipCastLoad: true }) to sync the transcript locally.
  if (!receiverMode) return;
  try {
    const ctx = window.cast && window.cast.framework &&
      window.cast.framework.CastReceiverContext &&
      window.cast.framework.CastReceiverContext.getInstance();
    if (!ctx) return;
    ctx.sendCustomMessage(CAST_NAMESPACE, undefined, {
      type: "episodeChanged",
      episodeId,
    });
    castLog("OK", "sent episodeChanged to sender:", episodeId);
  } catch (err) {
    castLog("WARN", "notifySenderEpisodeChanged failed:", err.message);
  }
}

/**
 * Establish a Cast media session on the RECEIVER when the receiver's own UI
 * selects an episode (D-pad navigation, episode picker).
 *
 * This is the ONLY correct way to load an episode on the receiver.  It calls
 * playerManager.load() with a synthetic LoadRequestData, which:
 * 1. Creates a proper Cast media session (so the sender's RemotePlayer tracks it)
 * 2. Sets audioEl.src via the framework's setMediaElement binding
 * 3. Triggers the LOAD interceptor, which loads the transcript via loadEpisode()
 *
 * WHY NOT call loadEpisode() + audioEl.play() directly?
 * - loadEpisode sets audioEl.src, then play() starts it.
 * - Then receiverEstablishMediaSession calls playerManager.load(), which also
 *   tries to load media into audioEl via setMediaElement.
 * - The two loads conflict: play() is interrupted → MEDIA_ELEMENT_ERROR (104),
 *   LOAD_FAILED (905).
 * - Solution: only go through playerManager.load() — let the framework own audioEl.
 *
 * @param {string} episodeId - The episode to load.
 */
function receiverEstablishMediaSession(episodeId) {
  if (!receiverMode || !receiverPlayerManager) return;
  const ep = episodes.find((item) => item.id === episodeId);
  if (!ep) return;

  // Build the authenticated media URL the same way the sender would.
  let mediaUrl = `${window.location.origin}${ep.audio}`;
  if (receiverAuthToken) {
    const sep = mediaUrl.includes("?") ? "&" : "?";
    mediaUrl = `${mediaUrl}${sep}rt=${encodeURIComponent(receiverAuthToken)}`;
  }

  castLog("INFO", "receiverEstablishMediaSession:", episodeId, mediaUrl);

  // Use the playerManager.load() API to create a proper media session.
  // This makes the sender's RemotePlayer recognise the active media.
  const castFramework = window.cast && window.cast.framework;
  if (!castFramework) return;

  // Build a synthetic LOAD request data object for the player manager.
  const loadRequestData = new castFramework.messages.LoadRequestData();
  loadRequestData.media = new castFramework.messages.MediaInformation();
  loadRequestData.media.contentId = mediaUrl;
  loadRequestData.media.contentUrl = mediaUrl;
  loadRequestData.media.contentType = "audio/mpeg";
  loadRequestData.media.streamType = castFramework.messages.StreamType.BUFFERED;
  loadRequestData.media.customData = { episodeId };
  loadRequestData.autoplay = true;
  loadRequestData.currentTime = 0;

  receiverPlayerManager.load(loadRequestData)
    .then(() => { castLog("OK", "receiver media session established for:", episodeId); })
    .catch((err) => { castLog("ERROR", "receiver media session load failed:", err); });
}

async function loadEpisodesForReceiver() {
  // Called when the receiver gets its auth token — fetches the episode list
  // and renders it.  Idempotent: skips if episodes are already loaded (e.g.
  // from the eager cookie-auth attempt in init()).
  castLog("INFO", "loadEpisodesForReceiver called");
  if (episodes.length) {
    castLog("INFO", "episodes already loaded — skipping");
    return;
  }
  try {
    await loadRuntimeConfig();
    episodes = await fetchJson("/api/episodes");
    castLog("OK", "episodes loaded for receiver:", episodes.length);
    filteredEpisodes = episodes.slice();
    statusTextEl.textContent = `${episodes.length} episode(s) found.`;
    renderEpisodeList();
    if (!currentEpisodeId) {
      openFsEpisodePicker();
    }
  } catch (err) {
    castLog("ERROR", "loadEpisodesForReceiver failed:", err.message);
  }
}

function hideTooltip() {
  // Immediately hide the translation tooltip and cancel any pending hide timer.
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  tooltipEl.classList.add("hidden");
}

function showTooltip(text, x, y, showExplain = false) {
  // Position the tooltip near the cursor with a 12px offset to avoid overlap.
  tooltipTextEl.textContent = text;
  tooltipEl.style.left = `${x + 12}px`;
  tooltipEl.style.top = `${y + 12}px`;
  tooltipExplainBtnEl.style.display = showExplain ? "inline-block" : "none";
  tooltipEl.classList.remove("hidden");
}

function hideTooltipSoon(delay = 180) {
  // Schedule tooltip hide after a short delay — allows the user to move their
  // mouse into the tooltip itself (to click "Explain to me") without it vanishing.
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hideTooltip(), delay);
}

tooltipEl.addEventListener("mouseenter", () => {
  // Cancel the hide timer when the mouse enters the tooltip itself,
  // allowing the user to interact with the "Explain to me" button.
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
});

tooltipEl.addEventListener("mouseleave", () => hideTooltipSoon(120));

tooltipExplainBtnEl.addEventListener("click", async () => {
  // "Explain to me" button: fetches a grammar/usage explanation from the server
  // (backed by an LLM) and replaces the tooltip content with a detailed breakdown.
  if (!tooltipWord) return;
  try {
    tooltipExplainBtnEl.disabled = true;
    tooltipExplainBtnEl.textContent = "Explaining...";
    const params = new URLSearchParams({ word: tooltipWord });
    if (tooltipContext) params.set("context", tooltipContext);
    castLog("INFO", "explain request:", tooltipWord);
    const data = await fetchJson(`/api/explain?${params}`);

    const lines = [];
    if (data.title) lines.push(data.title);
    if (Array.isArray(data.points) && data.points.length) {
      for (const p of data.points) lines.push(`- ${p}`);
    }
    if (Array.isArray(data.examples) && data.examples.length) {
      lines.push("Examples:");
      for (const ex of data.examples) lines.push(`* ${ex}`);
    }
    tooltipTextEl.textContent = lines.join("\n");
  } catch (err) {
    castLog("WARN", "explain failed:", tooltipWord, "—", err.message || "unknown");
    tooltipTextEl.textContent = "Could not load explanation.";
  } finally {
    tooltipExplainBtnEl.disabled = false;
    tooltipExplainBtnEl.textContent = "Explain to me";
  }
});

async function translateWord(word, context) {
  // Look up a single German word → English translation with morphological info.
  // Results are cached by (lowercase word + truncated context) to avoid
  // redundant API calls for the same word in the same sentence.
  const clean = word.trim().toLowerCase();
  const cacheKey = `${clean}||${(context || "").substring(0, 40)}`;
  if (!clean) return "";
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const params = new URLSearchParams({ word });
  if (context) params.set("context", context);
  try {
    const data = await fetchJson(`/api/translate?${params}`);
    const result = { display: data.display || "", translation: (data.translation || "").trim() };
    translationCache.set(cacheKey, result);
    return result;
  } catch (err) {
    castLog("WARN", "translateWord failed:", clean, "—", err.message);
    throw err;
  }
}

async function translateSegmentText(text) {
  // Translate a full German segment (sentence) to English.
  // Cached by exact text to avoid re-translating on repeated timeupdate calls.
  const clean = (text || "").trim();
  if (!clean) return "";
  if (segmentTranslationCache.has(clean)) return segmentTranslationCache.get(clean);

  try {
    const params = new URLSearchParams({ text: clean });
    const data = await fetchJson(`/api/translate-text?${params}`);
    const translation = (data.translation || "").trim();
    segmentTranslationCache.set(clean, translation);
    return translation;
  } catch (err) {
    castLog("WARN", "translateSegmentText failed:", clean.substring(0, 60), "—", err.message);
    throw err;
  }
}

function attachWordHover(node, word, context) {
  // Wire up mouse events on a word span for hover-to-translate:
  // - mouseenter: start a 160ms debounce timer, then fetch translation
  // - mousemove: reposition tooltip to follow the cursor
  // - mouseleave: schedule tooltip hide (with grace period for tooltip entry)
  node.addEventListener("mouseenter", (e) => {
    if (hoverTimer) clearTimeout(hoverTimer);
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    hoverTimer = setTimeout(async () => {
      try {
        tooltipWord = word;
        tooltipContext = context || "";
        showTooltip("…", e.clientX, e.clientY, false);
        const result = await translateWord(word, context);
        if (!result || !result.translation) {
          hideTooltip();
          return;
        }
        // Show: "der Hund" on first line, "dog (noun, nom, masc, sing)" below
        const display = result.display && result.display !== word
          ? `${result.display}\n${result.translation}`
          : result.translation;
        showTooltip(display, e.clientX, e.clientY, true);
      } catch (err) {
        castLog("WARN", "word hover translate failed:", word, "—", err.message || "unknown");
        hideTooltip();
      }
    }, 160);
  });

  node.addEventListener("mousemove", (e) => {
    if (!tooltipEl.classList.contains("hidden")) {
      tooltipEl.style.left = `${e.clientX + 12}px`;
      tooltipEl.style.top = `${e.clientY + 12}px`;
    }
  });

  node.addEventListener("mouseleave", () => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hideTooltipSoon(200);
  });
}

function appendInteractiveText(container, text, segmentIndex = -1) {
  // Render segment text as clickable, hoverable word spans.
  // Two paths:
  //   1. Word-level timing available (Whisper JSON): render from currentWords
  //      with data-word-index for word-level highlighting during playback.
  //   2. Fallback (SRT or no timing): split on whitespace and render plain spans.
  const range = (segmentIndex >= 0 && segmentWordRanges[segmentIndex]) ? segmentWordRanges[segmentIndex] : null;

  if (range && range.start <= range.end && currentWords.length > 0) {
    // Render directly from Whisper word tokens.
    // Whisper may split compound words (e.g. "Top" + "-Segment,") which would
    // never match a whitespace-split span — so we skip text-matching entirely.
    for (let i = range.start; i <= range.end; i++) {
      const w = currentWords[i];
      if (!w) continue;

      const raw = w.word || "";
      const trimmed = raw.trimStart();
      const hasLeadingSpace = raw.length !== trimmed.length;

      if (hasLeadingSpace && container.childNodes.length > 0) {
        container.appendChild(document.createTextNode(" "));
      }

      const wordEl = document.createElement("span");
      wordEl.className = "translatable-word";
      wordEl.textContent = trimmed;
      wordEl.dataset.wordIndex = String(i);
      wordEl.setAttribute("data-start", w.start);
      wordEl.setAttribute("data-end", w.end);

      const prob = w.probability ?? 1;
      if (prob < 0.6) {
        wordEl.classList.add("low-confidence");
        wordEl.title = `Low confidence: ${(prob * 100).toFixed(0)}%`;
      }

      wordEl.addEventListener("click", (e) => {
        e.stopPropagation();   // don't bubble to segment row
        _seekTo(w.start);
      });

      attachWordHover(wordEl, trimmed, text);
      container.appendChild(wordEl);
    }
  } else {
    // Fallback: plain whitespace split (SRT or no word-level timing).
    const parts = text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        container.appendChild(document.createTextNode(part));
        continue;
      }
      const wordEl = document.createElement("span");
      wordEl.className = "translatable-word";
      wordEl.textContent = part;
      attachWordHover(wordEl, part, text);
      container.appendChild(wordEl);
    }
  }
}

function appendSegmentCaption(container, translation, className) {
  // Create and append a translation caption div below a segment's German text.
  // Hidden by default if no translation text is available yet.
  const captionEl = document.createElement("div");
  captionEl.className = className;
  setCaptionText(captionEl, translation);
  container.appendChild(captionEl);
  return captionEl;
}

function setCaptionText(captionEl, translation) {
  // Update a caption element's text and visibility.  Empty translations hide
  // the element to avoid blank vertical space in the transcript.
  const text = (translation || "").trim();
  captionEl.textContent = text;
  captionEl.hidden = !text;
}

function ensureCaptionElement(rowEl, className) {
  // Find or create a caption sub-element within a segment row.
  // Used by updateRenderedSegmentCaption to inject translations after initial render.
  if (!rowEl) return null;

  let captionEl = rowEl.querySelector(`.${className}`);
  if (!captionEl) {
    captionEl = document.createElement("div");
    captionEl.className = className;
    rowEl.appendChild(captionEl);
  }
  return captionEl;
}

function updateRenderedSegmentCaption(index, translation) {
  // Push a newly-fetched translation into both the normal and fullscreen transcript
  // views without re-rendering the entire transcript DOM.
  const regularRow = transcriptViewerEl.querySelector(`.segment[data-index='${index}']`);
  const regularCaption = ensureCaptionElement(regularRow, "segment-caption");
  if (regularCaption) setCaptionText(regularCaption, translation);

  const fullscreenRow = fsTranscriptEl.querySelector(`.fs-segment[data-index='${index}']`);
  const fullscreenCaption = ensureCaptionElement(fullscreenRow, "fs-segment-caption");
  if (fullscreenCaption) setCaptionText(fullscreenCaption, translation);
}

function updateEpisodeListSelection() {
  const items = episodeListEl.querySelectorAll(".episode-item");
  for (const item of items) {
    item.classList.toggle("active", item.dataset.id === currentEpisodeId);
  }
}

async function loadSegmentTranslation(index, loadToken) {
  // Fetch and cache the English translation for a single segment.
  // Skips if the segment already has a translation (from the server or a previous fetch).
  // The loadToken check prevents stale fetches from a previous episode from
  // overwriting the current episode's transcript.
  if (loadToken !== activeEpisodeLoadToken) return;

  const segment = currentSegments[index];
  if (!segment) return;

  if ((segment.translation_en || "").trim()) {
    updateRenderedSegmentCaption(index, segment.translation_en);
    return;
  }

  try {
    const translation = await translateSegmentText(segment.text);
    if (loadToken !== activeEpisodeLoadToken) return;
    if (!currentSegments[index] || currentSegments[index].text !== segment.text) return;

    currentSegments[index].translation_en = translation;
    updateRenderedSegmentCaption(index, translation);
  } catch (err) {
    castLog("WARN", "loadSegmentTranslation failed for segment:", index, "—", err.message || "unknown");
    // Keep transcript usable even if translation loading fails.
  }
}

function ensureActiveSegmentTranslation() {
  // Triggered on each timeupdate — kicks off lazy translation loading
  // for segments near the current playback position.
  if (activeSegmentIndex < 0) return;
  void lazyTranslateAround(activeSegmentIndex, activeEpisodeLoadToken);
}

async function hydrateSegmentTranslations(loadToken) {
  // Lazy: only translate the active segment and a few neighbours.
  // Called from ensureActiveSegmentTranslation on each timeupdate.
  void lazyTranslateAround(activeSegmentIndex, loadToken);
}

let _translatingAroundCenter = -1;
// Re-entry guard: prevents duplicate translation requests when timeupdate
// fires multiple times while still translating the same segment window.

async function lazyTranslateAround(center, loadToken) {
  // Translate ±3 segments around the currently playing segment, starting
  // from the center and expanding outward.  Sequential await prevents
  // flooding the single-threaded Flask server with parallel requests.
  if (loadToken !== activeEpisodeLoadToken || !currentSegments.length) return;
  if (center < 0) center = 0;
  // Avoid re-entering for the same center — timeupdate fires frequently.
  if (center === _translatingAroundCenter) return;
  _translatingAroundCenter = center;

  // Translate a window of ±3 segments around the currently playing one.
  const LOOKAHEAD = 3;
  const start = Math.max(0, center - LOOKAHEAD);
  const end = Math.min(currentSegments.length - 1, center + LOOKAHEAD);

  // Current segment first, then outward.
  const indices = [center];
  for (let d = 1; d <= LOOKAHEAD; d++) {
    if (center + d <= end) indices.push(center + d);
    if (center - d >= start) indices.push(center - d);
  }

  // Translate the center segment first (await), then fire the rest in parallel.
  for (const index of indices) {
    if (loadToken !== activeEpisodeLoadToken) { _translatingAroundCenter = -1; return; }
    await loadSegmentTranslation(index, loadToken);
  }
  _translatingAroundCenter = -1;
}

function renderEpisodeList() {
  // Render the sidebar episode list.  On receiver, episode clicks go through
  // receiverEstablishMediaSession (Cast framework load), not loadEpisode directly.
  episodeListEl.innerHTML = "";

  if (filteredEpisodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No episodes found.";
    episodeListEl.appendChild(empty);
    return;
  }

  for (const ep of filteredEpisodes) {
    const item = document.createElement("div");
    item.className = "episode-item" + (ep.id === currentEpisodeId ? " active" : "");
    item.dataset.id = ep.id;

    const title = document.createElement("div");
    title.textContent = ep.title;

    const meta = document.createElement("div");
    meta.className = "episode-meta";
    meta.textContent = `${ep.id} · transcript: ${ep.transcript_type}`;

    item.appendChild(title);
    item.appendChild(meta);
    item.addEventListener("click", async () => {
      castLog("INFO", "episode item clicked:", ep.id);
      if (receiverMode) {
        // Let the Cast framework load media via playerManager.load() — the
        // LOAD interceptor will call loadEpisode(id, {skipAudioSrc: true})
        // for the transcript.  Calling loadEpisode directly would set
        // audioEl.src and conflict with the framework's own load.
        receiverEstablishMediaSession(ep.id);
        notifySenderEpisodeChanged(ep.id);
      } else {
        await loadEpisode(ep.id);
      }
    });
    episodeListEl.appendChild(item);
  }
}

function renderFsEpisodePicker() {
  if (!fsEpisodePickerListEl) return;
  fsEpisodePickerListEl.innerHTML = "";

  if (!episodes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No episodes found.";
    fsEpisodePickerListEl.appendChild(empty);
    return;
  }

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-item" + (i === fsEpisodePickerIndex ? " active" : "");
    btn.dataset.index = String(i);
    btn.innerHTML = `${ep.title}<span class="picker-meta">${ep.id} · transcript: ${ep.transcript_type}</span>`;
    btn.addEventListener("click", async () => {
      fsEpisodePickerIndex = i;
      castLog("INFO", "episode picker button clicked:", ep.id);
      await selectEpisodeFromFsPicker();
    });
    fsEpisodePickerListEl.appendChild(btn);
  }

  const activeBtn = fsEpisodePickerListEl.querySelector(`.picker-item[data-index='${fsEpisodePickerIndex}']`);
  if (activeBtn && activeBtn.scrollIntoView) {
    activeBtn.scrollIntoView({ block: "nearest" });
    if (document.activeElement === receiverEpisodesBtnEl || document.activeElement === fsEpisodePickerCloseBtnEl) {
      activeBtn.focus();
    }
  }
}

function openFsEpisodePicker() {
  if (!fsEpisodePickerEl) return;
  if (!episodes.length) return;

  castLog("INFO", "openFsEpisodePicker — episodes:", episodes.length, "current:", currentEpisodeId || "none");
  const selectedIdx = episodes.findIndex((ep) => ep.id === currentEpisodeId);
  fsEpisodePickerIndex = selectedIdx >= 0 ? selectedIdx : 0;
  isFsEpisodePickerOpen = true;
  fsEpisodePickerEl.classList.remove("hidden");
  renderFsEpisodePicker();
}

function closeFsEpisodePicker() {
  if (!fsEpisodePickerEl) return;
  castLog("INFO", "closeFsEpisodePicker");
  isFsEpisodePickerOpen = false;
  fsEpisodePickerEl.classList.add("hidden");
}

function moveFsEpisodePicker(delta) {
  if (!episodes.length) return;
  if (fsEpisodePickerIndex < 0) fsEpisodePickerIndex = 0;
  fsEpisodePickerIndex = (fsEpisodePickerIndex + delta + episodes.length) % episodes.length;
  renderFsEpisodePicker();
}

async function selectEpisodeFromFsPicker() {
  if (fsEpisodePickerIndex < 0 || fsEpisodePickerIndex >= episodes.length) return;
  const ep = episodes[fsEpisodePickerIndex];
  if (!ep) return;
  castLog("INFO", "selectEpisodeFromFsPicker:", ep.id, "index:", fsEpisodePickerIndex);
  closeFsEpisodePicker();
  if (receiverMode) {
    receiverEstablishMediaSession(ep.id);
    notifySenderEpisodeChanged(ep.id);
  } else {
    await loadEpisode(ep.id);
  }
}

function renderSegments(segments) {
  // Render the main (non-fullscreen) transcript view as a list of clickable
  // segment rows, each containing interactive word spans and a caption div.
  transcriptViewerEl.innerHTML = "";

  if (!segments || segments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No timestamped transcript found for this episode.";
    transcriptViewerEl.appendChild(empty);
    return;
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const row = document.createElement("div");
    row.className = "segment";
    row.dataset.index = String(i);

    const text = document.createElement("div");
    text.className = "segment-text";
    appendInteractiveText(text, seg.text, i);  // Pass segment index for word tracking

    row.appendChild(text);
    appendSegmentCaption(row, seg.translation_en, "segment-caption");
    row.addEventListener("click", () => {
      _seekTo(seg.start);
    });

    transcriptViewerEl.appendChild(row);
  }
}

function renderPlainText(text) {
  transcriptViewerEl.innerHTML = "";
  if (!text || text.trim() === "") {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No transcript file found for this episode yet.";
    transcriptViewerEl.appendChild(empty);
    return;
  }

  const paragraphs = text.split(/\r?\n/).filter(Boolean);
  for (const p of paragraphs) {
    const row = document.createElement("div");
    row.className = "segment";
    row.textContent = p;
    transcriptViewerEl.appendChild(row);
  }
}

function renderWords(words) {
  // Alternative rendering mode: word-level view (no segment grouping).
  // Groups words by their context string (which maps to the parent segment text)
  // so the display still appears as rows rather than one continuous blob.
  transcriptViewerEl.innerHTML = "";
  if (!words || words.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No word-level timing data.";
    transcriptViewerEl.appendChild(empty);
    return;
  }

  const container = document.createElement("div");
  container.className = "words-container";

  // Group words by segment context so the transcript appears as rows, not one blob.
  let currentContext = null;
  let currentRow = null;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const context = word.context || "";

    if (context !== currentContext) {
      currentContext = context;
      currentRow = document.createElement("div");
      currentRow.className = "segment word-segment";
      const rowStart = Number(word.start) || 0;
      currentRow.dataset.start = String(rowStart);
      currentRow.addEventListener("click", (e) => {
        // Avoid double-seeking when clicking directly on a word span.
        if (e.target && e.target.classList && e.target.classList.contains("word")) {
          return;
        }
        _seekTo(rowStart);
      });
      container.appendChild(currentRow);
    }

    const wordEl = document.createElement("span");
    wordEl.className = "word translatable-word";
    wordEl.dataset.index = String(i);

    // Dim words with low transcription confidence (probability < 0.6)
    const prob = word.probability ?? 1;
    if (prob < 0.6) {
      wordEl.classList.add("low-confidence");
      wordEl.title = `Low confidence: ${(prob * 100).toFixed(0)}%`;
    }

    wordEl.textContent = word.word;
    wordEl.addEventListener("click", () => {
      _seekTo(word.start);
    });

    attachWordHover(wordEl, word.word.trim(), context);
    currentRow.appendChild(wordEl);
    currentRow.appendChild(document.createTextNode(" "));
  }

  transcriptViewerEl.appendChild(container);
}

function updateActiveSegment() {
  // Called on every timeupdate (~4Hz).  Finds which segment contains the
  // current audio time and highlights it, scrolling it into view.
  // Also triggers lazy translation loading for nearby segments.
  if (!currentSegments.length) return;

  const t = audioEl.currentTime;
  let nextIndex = -1;
  for (let i = 0; i < currentSegments.length; i++) {
    const seg = currentSegments[i];
    if (t >= seg.start && t < seg.end) {
      nextIndex = i;
      break;
    }
  }

  if (nextIndex === activeSegmentIndex) return;

  const prevEl = transcriptViewerEl.querySelector(".segment.active");
  if (prevEl) prevEl.classList.remove("active");

  activeSegmentIndex = nextIndex;
  if (activeSegmentIndex >= 0) {
    const activeEl = transcriptViewerEl.querySelector(`.segment[data-index='${activeSegmentIndex}']`);
    if (activeEl) {
      activeEl.classList.add("active");
      activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    ensureActiveSegmentTranslation();
  }
}

function updateActiveWord() {
   // Early return if no words available
   if (!currentWords || !Array.isArray(currentWords) || currentWords.length === 0) {
     return;
   }

   const t = audioEl.currentTime;
   let nextIndex = -1;

   // Find the word that matches the current audio time
   for (let i = 0; i < currentWords.length; i++) {
     const word = currentWords[i];
     if (word && word.start !== undefined && word.end !== undefined) {
       if (t >= word.start && t < word.end) {
         nextIndex = i;
         break;
       }
     }
   }

   // No change if same word is active
   if (nextIndex === activeWordIndex) return;

   // Remove previous active word highlight from all possible selectors
   const prevEls = transcriptViewerEl.querySelectorAll("[data-word-index].active, .word.active, .translatable-word.active");
   for (const el of prevEls) {
     el.classList.remove("active");
   }

   // Set new active word
   activeWordIndex = nextIndex;
   if (activeWordIndex >= 0) {
     // Try multiple selectors: data-word-index (segment rendering), data-index (word rendering)
     let activeEl = transcriptViewerEl.querySelector(`[data-word-index='${activeWordIndex}']`);
     if (!activeEl) {
       activeEl = transcriptViewerEl.querySelector(`.word[data-index='${activeWordIndex}']`);
     }
     if (activeEl) {
       activeEl.classList.add("active");
      activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
     }
   }
}

async function loadEpisode(id, { skipCastLoad = false, skipAudioSrc = false } = {}) {
  // Core episode loading function.  Fetches transcript data and sets up audio.
  //
  // Options:
  //   skipCastLoad: true when called from receiver's Cast message (don't echo
  //                 a LOAD back to receiver) or from the sender's namespace
  //                 listener (receiver already has the episode).
  //   skipAudioSrc: true when called from the LOAD interceptor on the receiver —
  //                 the Cast framework sets audioEl.src via setMediaElement,
  //                 so we must not overwrite it here.
  //
  // Uses a monotonic loadToken to cancel stale calls — if the user rapidly
  // switches episodes, only the latest loadEpisode completes.
  const loadToken = ++activeEpisodeLoadToken;
  castLog("INFO", "loadEpisode:", id, "token:", loadToken,
    "skipCastLoad:", skipCastLoad, "skipAudioSrc:", skipAudioSrc);
  currentEpisodeId = id;
  closeFsEpisodePicker();
  updateEpisodeListSelection();
  episodeTitleEl.textContent = `Loading ${id}...`;
  transcriptViewerEl.innerHTML = '<div class="empty">Loading transcript...</div>';

  try {
    const data = await fetchJson(`/api/episode/${encodeURIComponent(id)}`);
    if (loadToken !== activeEpisodeLoadToken) {
      castLog("INFO", "loadEpisode cancelled — token mismatch:", loadToken, "vs", activeEpisodeLoadToken);
      return;
    }

    currentEpisodeId = data.id;
    currentSegments = [];
    currentWords = [];
    segmentWordRanges = [];
    activeSegmentIndex = -1;
    activeWordIndex = -1;

    episodeTitleEl.textContent = data.title;

    // Set audio source — unless the Cast framework is already loading media
    // via setMediaElement (LOAD interceptor passes skipAudioSrc: true).
    if (!skipAudioSrc) {
      if (receiverMode && receiverAuthToken) {
        const sep = data.audio.includes("?") ? "&" : "?";
        audioEl.src = `${data.audio}${sep}rt=${encodeURIComponent(receiverAuthToken)}`;
        castLog("INFO", "audioEl.src set (receiver, with token)");
      } else {
        audioEl.src = data.audio;
        castLog("INFO", "audioEl.src set:", data.audio);
      }
    } else {
      castLog("INFO", "audioEl.src skipped (skipAudioSrc)");
    }

    // Send LOAD to Chromecast — unless this call originated from the receiver
    // (which already has the episode loaded) to prevent an echo loop.
    // Start from 0 — this is a new episode, not a resume.
    if (castSession && !skipCastLoad) {
      castLog("INFO", "sending LOAD to Chromecast for new episode");
      loadCurrentEpisodeOnCastSession(castSession, 0);
    }

    if (data.transcript_type === "json" || data.transcript_type === "srt") {
      syncHintEl.textContent = "Synced transcript enabled. Click a line to jump audio.";
      currentSegments = data.segments || [];
      currentWords = data.words || [];

      if (currentWords.length > 0) {
        let wPtr = 0;
        for (let si = 0; si < currentSegments.length; si++) {
          const segCtx = (currentSegments[si].text || "").trim().toLowerCase();
          const startIdx = wPtr;
          while (wPtr < currentWords.length) {
            if ((currentWords[wPtr].context || "").trim().toLowerCase() !== segCtx) break;
            wPtr++;
          }
          segmentWordRanges.push({ start: startIdx, end: wPtr - 1 });
        }
      }

      renderSegments(currentSegments);
      if (isFullscreen) {
        renderFsSegments(currentSegments);
        updateFsCaptionVisibility();
      }
      void hydrateSegmentTranslations(loadToken);
      castLog("OK", "loadEpisode complete:", id, "type:", data.transcript_type,
        "segments:", currentSegments.length, "words:", currentWords.length);
    } else if (data.transcript_type === "txt") {
      syncHintEl.textContent = "Plain text transcript (no timestamps available).";
      renderPlainText(data.text || "");
      castLog("OK", "loadEpisode complete:", id, "type: txt (no timestamps)");
      if (isFullscreen) {
        fsTranscriptEl.innerHTML = '<div class="fs-empty">No timestamped transcript available.</div>';
      }
    } else {
      syncHintEl.textContent = "No transcript yet. Generate with transcribe_podcasts.py.";
      renderPlainText("");
      castLog("OK", "loadEpisode complete:", id, "type: none");
      if (isFullscreen) {
        fsTranscriptEl.innerHTML = '<div class="fs-empty">No transcript available.</div>';
      }
    }

    updateEpisodeListSelection();
    renderFsEpisodePicker();
  } catch (err) {
    if (loadToken !== activeEpisodeLoadToken) {
      castLog("INFO", "loadEpisode error suppressed — token mismatch:", loadToken);
      return;
    }
    castLog("ERROR", "loadEpisode failed:", id, "—", err.message);
    statusTextEl.textContent = `Error loading episode: ${err.message}`;
  }
}

function applyFilter() {
  const q = searchInputEl.value.trim().toLowerCase();
  if (!q) {
    filteredEpisodes = episodes.slice();
  } else {
    filteredEpisodes = episodes.filter((ep) => ep.id.toLowerCase().includes(q) || ep.title.toLowerCase().includes(q));
  }
  renderEpisodeList();
}

// ── Fullscreen ──────────────────────────────────────────────────────────────

function appendFsInteractiveText(container, text, segmentIndex = -1) {
  // Same as appendInteractiveText but uses data-fs-word-index attributes
  // so fullscreen word highlighting doesn't collide with normal view selectors.
  const range = (segmentIndex >= 0 && segmentWordRanges[segmentIndex]) ? segmentWordRanges[segmentIndex] : null;

  if (range && range.start <= range.end && currentWords.length > 0) {
    for (let i = range.start; i <= range.end; i++) {
      const w = currentWords[i];
      if (!w) continue;

      const raw = w.word || "";
      const trimmed = raw.trimStart();
      const hasLeadingSpace = raw.length !== trimmed.length;

      if (hasLeadingSpace && container.childNodes.length > 0) {
        container.appendChild(document.createTextNode(" "));
      }

      const wordEl = document.createElement("span");
      wordEl.className = "translatable-word";
      wordEl.textContent = trimmed;
      wordEl.dataset.fsWordIndex = String(i);
      wordEl.setAttribute("data-fs-start", w.start);
      wordEl.setAttribute("data-fs-end", w.end);

      const prob = w.probability ?? 1;
      if (prob < 0.6) {
        wordEl.classList.add("low-confidence");
        wordEl.title = `Low confidence: ${(prob * 100).toFixed(0)}%`;
      }

      wordEl.addEventListener("click", (e) => {
        e.stopPropagation();   // don't bubble to segment row
        _seekTo(w.start);
      });

      attachWordHover(wordEl, trimmed, text);
      container.appendChild(wordEl);
    }
  } else {
    // Fallback: plain whitespace split.
    const parts = text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        container.appendChild(document.createTextNode(part));
        continue;
      }
      const wordEl = document.createElement("span");
      wordEl.className = "translatable-word";
      wordEl.textContent = part;
      attachWordHover(wordEl, part, text);
      container.appendChild(wordEl);
    }
  }
}

function renderFsSegments(segments) {
  fsTranscriptEl.innerHTML = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const row = document.createElement("div");
    row.className = "fs-segment";
    row.dataset.index = String(i);
    const text = document.createElement("div");
    text.className = "fs-segment-text";
    appendFsInteractiveText(text, seg.text, i);  // Pass segment index
    row.appendChild(text);
    appendSegmentCaption(row, seg.translation_en, "fs-segment-caption");
    row.addEventListener("click", () => {
      _seekTo(seg.start);
    });
    fsTranscriptEl.appendChild(row);
  }
}

function renderFsWords(words) {
  fsTranscriptEl.innerHTML = "";
  if (!words || words.length === 0) return;
  let currentContext = null;
  let currentRow = null;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const context = word.context || "";
    if (context !== currentContext) {
      currentContext = context;
      currentRow = document.createElement("div");
      currentRow.className = "fs-segment word-segment";
      const rowStart = Number(word.start) || 0;
      currentRow.dataset.start = String(rowStart);
      currentRow.addEventListener("click", (e) => {
        if (e.target && e.target.classList && e.target.classList.contains("fs-word")) return;
        _seekTo(rowStart);
      });
      fsTranscriptEl.appendChild(currentRow);
    }
    const wordEl = document.createElement("span");
    wordEl.className = "fs-word translatable-word";
    wordEl.dataset.index = String(i);
    const prob = word.probability ?? 1;
    if (prob < 0.6) {
      wordEl.classList.add("low-confidence");
      wordEl.title = `Low confidence: ${(prob * 100).toFixed(0)}%`;
    }
    wordEl.textContent = word.word;
    wordEl.addEventListener("click", () => {
      _seekTo(word.start);
    });
    attachWordHover(wordEl, word.word.trim(), context);
    currentRow.appendChild(wordEl);
    currentRow.appendChild(document.createTextNode(" "));
  }
}

function _hideFsOverlay() {
  isFullscreen = false;
  fsActiveSegmentIndex = -1;
  fsActiveWordIndex = -1;
  fsOverlayEl.classList.remove("fs-paused");
  fsOverlayEl.classList.add("hidden");
}

function updateFsCaptionVisibility() {
  // Toggle "fs-paused" class on the fullscreen overlay — used by CSS to show/hide
  // translation captions (visible when paused, hidden during playback to reduce clutter).
  fsOverlayEl.classList.toggle("fs-paused", isFullscreen && audioEl.paused);
  if (receiverToggleBtnEl) {
    receiverToggleBtnEl.textContent = audioEl.paused ? "Play" : "Pause";
  }
}

function seekToSegment(index) {
  if (!currentSegments.length) return;
  const target = Math.max(0, Math.min(index, currentSegments.length - 1));
  const seg = currentSegments[target];
  if (!seg) return;
  _seekTo(seg.start);
}

function jumpToNextSegment() {
  // Find the first segment that starts after the current time (+50ms lookahead
  // to avoid re-selecting the current segment if we're right at its start).
  if (!currentSegments.length) return;
  const t = audioEl.currentTime + 0.05;
  let nextIdx = currentSegments.findIndex((seg) => seg.start > t);
  if (nextIdx < 0) nextIdx = currentSegments.length - 1;
  castLog("INFO", "jumpToNextSegment → index:", nextIdx, "from:", t.toFixed(1));
  seekToSegment(nextIdx);
}

function jumpToPreviousSegment() {
  // Find the last segment that starts at or before (currentTime - 350ms).
  // The 350ms offset means a quick double-tap goes to the segment before the
  // current one, while a single tap near the start re-starts the current segment.
  if (!currentSegments.length) return;
  const t = Math.max(0, audioEl.currentTime - 0.35);
  let prevIdx = 0;
  for (let i = 0; i < currentSegments.length; i++) {
    if (currentSegments[i].start <= t) {
      prevIdx = i;
    } else {
      break;
    }
  }
  castLog("INFO", "jumpToPreviousSegment → index:", prevIdx, "from:", t.toFixed(1));
  seekToSegment(prevIdx);
}

function togglePlayPause() {
  // Toggle local audio playback.  When casting, also toggle the remote via
  // remotePlayerController.playOrPause() to keep sender and receiver in sync.
  castLog("INFO", "togglePlayPause — paused:", audioEl.paused,
    "src:", audioEl.src ? "set" : "empty", "readyState:", audioEl.readyState);
  if (audioEl.paused) {
    const p = audioEl.play();
    if (p && p.catch) {
      p.catch((err) => {
        castLog("ERROR", "togglePlayPause play() rejected:", err.message);
      });
    }
  } else {
    audioEl.pause();
  }
  // Mirror to Chromecast when casting.
  if (_isCasting()) {
    remotePlayerController.playOrPause();
  }
}

function enterFullscreen() {
  castLog("INFO", "enterFullscreen — receiverMode:", receiverMode, "segments:", currentSegments.length);
  isFullscreen = true;
  fsActiveSegmentIndex = -1;
  fsActiveWordIndex = -1;

  if (currentSegments.length) {
    renderFsSegments(currentSegments);
  } else {
    fsTranscriptEl.innerHTML = '<div class="fs-empty">No transcript available.</div>';
  }

  if (receiverMode) {
    document.body.classList.add("receiver-mode");
  }
  fsOverlayEl.classList.remove("hidden");
  updateFsCaptionVisibility();
  ensureActiveSegmentTranslation();
  updateFsProgress();

  if (activeSegmentIndex >= 0) {
    const el = fsTranscriptEl.querySelector(`.fs-segment[data-index='${activeSegmentIndex}']`);
    if (el) {
      el.classList.add("active");
      fsActiveSegmentIndex = activeSegmentIndex;
      el.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }
  if (activeWordIndex >= 0) {
    const el = fsTranscriptEl.querySelector(`[data-fs-word-index='${activeWordIndex}'], .fs-word[data-index='${activeWordIndex}']`);
    if (el) {
      el.classList.add("active");
      fsActiveWordIndex = activeWordIndex;
    }
  }

  if (!currentEpisodeId) {
    openFsEpisodePicker();
  }
}

function exitFullscreen() {
  if (receiverMode) return;
  castLog("INFO", "exitFullscreen");
  isFullscreen = false;
  fsActiveSegmentIndex = -1;
  fsActiveWordIndex = -1;
  closeFsEpisodePicker();
  fsOverlayEl.classList.add("hidden");
  fsOverlayEl.classList.remove("fs-paused");
}

function updateFsProgress() {
  if (!isFullscreen) return;
  const pct = audioEl.duration ? (audioEl.currentTime / audioEl.duration) * 100 : 0;
  fsProgressFillEl.style.width = pct + "%";
}

function updateFsActiveSegment() {
  // Fullscreen equivalent of updateActiveSegment.
  // Returns early (instead of setting -1) when no segment matches — this keeps
  // the previous segment highlighted through inter-segment gaps, avoiding flicker.
  if (!isFullscreen || !currentSegments.length) return;
  const t = audioEl.currentTime;
  let nextIndex = -1;
  for (let i = 0; i < currentSegments.length; i++) {
    const seg = currentSegments[i];
    if (t >= seg.start && t < seg.end) { nextIndex = i; break; }
  }
  // Stay on the current segment through inter-segment gaps to avoid flickering.
  if (nextIndex === -1) return;
  if (nextIndex === fsActiveSegmentIndex) return;
  const prevEl = fsTranscriptEl.querySelector(".fs-segment.active");
  if (prevEl) prevEl.classList.remove("active");
  fsActiveSegmentIndex = nextIndex;
  const activeEl = fsTranscriptEl.querySelector(`.fs-segment[data-index='${fsActiveSegmentIndex}']`);
  if (activeEl) { activeEl.classList.add("active"); activeEl.scrollIntoView({ block: "center", behavior: "smooth" }); }
}

function updateFsActiveWord() {
  // Fullscreen equivalent of updateActiveWord.
  // Only touches word-level .active class — segment-level highlighting is
  // managed exclusively by updateFsActiveSegment to avoid conflicts.
   if (!isFullscreen || !currentWords || !Array.isArray(currentWords) || currentWords.length === 0) return;

   const t = audioEl.currentTime;
   let nextIndex = -1;

   for (let i = 0; i < currentWords.length; i++) {
     const word = currentWords[i];
     if (word && word.start !== undefined && word.end !== undefined) {
       if (t >= word.start && t < word.end) {
         nextIndex = i;
         break;
       }
     }
   }

   // Stay on current word through inter-word gaps to avoid flickering.
   if (nextIndex === -1) return;
   if (nextIndex === fsActiveWordIndex) return;

   // Remove active highlight from the previous word span only.
   // Segment-level .active is managed exclusively by updateFsActiveSegment —
   // touching it here caused the whole segment to lose its highlight when a
   // word couldn't be matched (e.g. Whisper splits "Top-Segment," into two tokens).
   fsTranscriptEl.querySelectorAll("[data-fs-word-index].active, .fs-word.active")
     .forEach(el => el.classList.remove("active"));

   fsActiveWordIndex = nextIndex;
   let activeEl = fsTranscriptEl.querySelector(`[data-fs-word-index='${fsActiveWordIndex}']`);
   if (!activeEl) {
     activeEl = fsTranscriptEl.querySelector(`.fs-word[data-index='${fsActiveWordIndex}']`);
   }
   if (activeEl) {
     activeEl.classList.add("active");
     // Scrolling is handled at segment granularity by updateFsActiveSegment;
     // word-level scroll would fight with it and cause jitter.
   }
}

// Progress bar click-to-seek: calculate time from click position relative
// to the progress bar track width.  autoPlay=false so clicking the bar
// while paused doesn't accidentally start playback.
fsProgressTrackEl.addEventListener("click", (e) => {
  if (!audioEl.duration) return;
  const rect = fsProgressTrackEl.getBoundingClientRect();
  const time = ((e.clientX - rect.left) / rect.width) * audioEl.duration;
  _seekTo(time, false);
});

if (fsExitBtnEl) fsExitBtnEl.addEventListener("click", exitFullscreen);
if (fullscreenBtnEl) fullscreenBtnEl.addEventListener("click", enterFullscreen);

if (receiverPrevBtnEl) receiverPrevBtnEl.addEventListener("click", jumpToPreviousSegment);
if (receiverNextBtnEl) receiverNextBtnEl.addEventListener("click", jumpToNextSegment);

// Long-press the Play/Pause button to toggle the cast debug panel.
// Short tap still toggles play/pause as before.
const LONG_PRESS_MS = 1600;
let _toggleLongPressTimer = null;
let _toggleDidLongPress = false;
if (receiverToggleBtnEl) {
  receiverToggleBtnEl.addEventListener("pointerdown", (e) => {
    _toggleDidLongPress = false;
    _toggleLongPressTimer = setTimeout(() => {
      _toggleDidLongPress = true;
      _toggleLongPressTimer = null;
      toggleCastDebugPanel();
    }, LONG_PRESS_MS);
  });
  receiverToggleBtnEl.addEventListener("pointerup", () => {
    if (_toggleLongPressTimer) {
      clearTimeout(_toggleLongPressTimer);
      _toggleLongPressTimer = null;
    }
    if (!_toggleDidLongPress) {
      togglePlayPause();
    }
    _toggleDidLongPress = false;
  });
  receiverToggleBtnEl.addEventListener("pointercancel", () => {
    if (_toggleLongPressTimer) {
      clearTimeout(_toggleLongPressTimer);
      _toggleLongPressTimer = null;
    }
    _toggleDidLongPress = false;
  });
  receiverToggleBtnEl.addEventListener("pointerleave", () => {
    if (_toggleLongPressTimer) {
      clearTimeout(_toggleLongPressTimer);
      _toggleLongPressTimer = null;
    }
    _toggleDidLongPress = false;
  });
}

// Chromecast remote / Google TV remote behavior:
// - Episode picker open: up/down to move, enter/select, back to close.
// - Episode picker closed: left/right for segment nav, enter/space play/pause,
//   up/down to open episode picker.
// - Media keys: MediaPlayPause, MediaTrackNext, MediaTrackPrevious.
//
// We use { capture: true } so the handler fires BEFORE any focused element
// (e.g. native audio controls) or the Cast framework can consume the event.
// Every handled branch calls stopPropagation + preventDefault to prevent the
// browser/system from showing the native audio player bar or seeking the audio
// via built-in controls.

// ── Long-press Enter/Space tracking for debug panel toggle ──────────────
let _enterLongPressTimer = null;
let _enterDidLongPress = false;

document.addEventListener("keydown", async (e) => {
  if (!isFullscreen) return;

  // Always re-focus body so next keypress is captured by us, not native UI.
  if (document.activeElement && document.activeElement !== document.body) {
    document.body.focus();
  }

  // Helper: consume the event completely.
  function consume() {
    e.preventDefault();
    e.stopPropagation();
  }

  // Chromecast / Google TV remotes set e.key but may leave e.code empty
  // for the center D-pad button.  Check both for keyboard + remote compat.
  const isConfirmKey = e.key === "Enter" || e.key === " " || e.code === "Enter" || e.code === "Space";
  const isBackKey = e.key === "Escape" || e.key === "GoBack" || e.key === "Backspace"
    || e.code === "Escape" || e.code === "Backspace";

  // ── Media keys (Google TV remote play/pause/skip buttons) ──────────
  if (e.key === "MediaPlayPause") {
    consume();
    castLog("INFO", "key: MediaPlayPause");
    togglePlayPause();
    return;
  }
  if (e.key === "MediaPlay") {
    consume();
    castLog("INFO", "key: MediaPlay");
    if (audioEl.paused) audioEl.play();
    if (_isCasting() && remotePlayer.isPaused) remotePlayerController.playOrPause();
    return;
  }
  if (e.key === "MediaPause") {
    consume();
    castLog("INFO", "key: MediaPause");
    if (!audioEl.paused) audioEl.pause();
    if (_isCasting() && !remotePlayer.isPaused) remotePlayerController.playOrPause();
    return;
  }
  if (e.key === "MediaTrackNext") {
    consume();
    castLog("INFO", "key: MediaTrackNext");
    jumpToNextSegment();
    return;
  }
  if (e.key === "MediaTrackPrevious") {
    consume();
    castLog("INFO", "key: MediaTrackPrevious");
    jumpToPreviousSegment();
    return;
  }

  // ── Episode picker open ────────────────────────────────────────────
  if (isFsEpisodePickerOpen) {
    if (e.code === "ArrowUp") {
      consume();
      castLog("INFO", "picker: ArrowUp");
      moveFsEpisodePicker(-1);
      return;
    }
    if (e.code === "ArrowDown") {
      consume();
      castLog("INFO", "picker: ArrowDown");
      moveFsEpisodePicker(1);
      return;
    }
    // Enter/Space in picker: handled via the keydown/keyup long-press logic
    // below (short press → select episode, long press → debug panel).
    if (isConfirmKey) {
      // Fall through to the long-press Enter handler below.
    } else if (isBackKey) {
      consume();
      castLog("INFO", "picker: back key — closing");
      if (currentEpisodeId) closeFsEpisodePicker();
      return;
    } else {
      // Swallow any other key while picker is open to prevent native handling.
      consume();
      return;
    }
  }

  // ── Playback controls (D-pad) ──────────────────────────────────────
  if (e.code === "ArrowLeft") {
    consume();
    castLog("INFO", "key: ArrowLeft → prevSegment");
    jumpToPreviousSegment();
    return;
  }
  if (e.code === "ArrowRight") {
    consume();
    castLog("INFO", "key: ArrowRight → nextSegment");
    jumpToNextSegment();
    return;
  }
  // Enter/Space: short press → play/pause, long press → debug panel.
  // We start a timer on keydown; keyup decides whether it was short or long.
  if (isConfirmKey) {
    consume();
    if (!_enterLongPressTimer && !_enterDidLongPress) {
      castLog("INFO", "keydown confirm — starting long-press timer");
      _enterDidLongPress = false;
      _enterLongPressTimer = setTimeout(() => {
        _enterDidLongPress = true;
        _enterLongPressTimer = null;
        castLog("INFO", "long-press threshold reached — toggling debug panel");
        toggleCastDebugPanel();
      }, LONG_PRESS_MS);
    }
    return;
  }
  if (e.code === "ArrowUp") {
    consume();
    castLog("INFO", "key: ArrowUp → openPicker");
    openFsEpisodePicker();
    return;
  }
  if (e.code === "ArrowDown") {
    consume();
    castLog("INFO", "key: ArrowDown → openPicker");
    openFsEpisodePicker();
    return;
  }
  if (isBackKey) {
    consume();
    castLog("INFO", "key: back → openPicker");
    openFsEpisodePicker();
    return;
  }

  // In receiver mode, swallow any remaining keys so they never reach
  // the native audio element or trigger system-level media controls.
  if (receiverMode) {
    consume();
  }
}, /* capture */ true);


document.addEventListener("keyup", (e) => {
  // Complete the long-press detection started in keydown.
  // If released before the 1.6s threshold, treat as a short press:
  //   - Picker open → select episode
  //   - No episode → open picker
  //   - Otherwise → toggle play/pause
  if (!isFullscreen) return;
  const isConfirmKey = e.key === "Enter" || e.key === " " || e.code === "Enter" || e.code === "Space";
  if (isConfirmKey) {
    e.preventDefault();
    e.stopPropagation();
    castLog("INFO", "keyup confirm — timer:", !!_enterLongPressTimer,
      "picker:", isFsEpisodePickerOpen, "episode:", currentEpisodeId || "none");
    if (_enterLongPressTimer) {
      // Released before the long-press threshold — treat as short press.
      clearTimeout(_enterLongPressTimer);
      _enterLongPressTimer = null;
      if (isFsEpisodePickerOpen) {
        // Picker is open — select the highlighted episode.
        selectEpisodeFromFsPicker();
      } else if (!currentEpisodeId) {
        // No episode loaded — open the picker so the user can choose one.
        openFsEpisodePicker();
      } else {
        togglePlayPause();
      }
    }
    _enterDidLongPress = false;
  }
}, /* capture */ true);

// Kick off the application.
init();
