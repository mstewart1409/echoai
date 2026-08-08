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
//
//   WHY NOT just poll remotePlayer.currentTime?
//   - RemotePlayer updates are asynchronous and coarse (~1s granularity).
//   - Using it directly for transcript tracking produces jerky, delayed updates.
//   - The local muted audio gives smooth, browser-native timeupdate (~4Hz).
//
//   ONE RECONCILER, MANY TRIGGERS (sender side):
//   reconcileLocalToRemote() is the ONLY function permitted to write
//   audioEl.currentTime or change audioEl's play state while casting.  Three
//   triggers call it and do nothing else themselves:
//     · IS_PAUSED_CHANGED   — the receiver started or stopped
//     · CURRENT_TIME_CHANGED — the receiver reported a position
//     · 500ms poll           — catches anything the events missed
//   _seekTo() is the one exception, and deliberately so: a seek is a user
//   COMMAND that drives both clocks to a chosen position, not a convergence.
//
//   Every sync bug in this file's history came from two handlers each holding
//   their own half of the policy and fighting: one resurrecting local playback
//   while another snapped it back, or a pause path that skipped correction and
//   left the local element seconds ahead.  Keep the policy in the reconciler.
//   If a new trigger is needed, call the reconciler from it — do not touch
//   audioEl directly.
//
//   Reconciler policy:
//   - Position: converge on the receiver past CAST_DRIFT_TOLERANCE_SEC, whether
//     playing or paused.  Correcting while paused is free (the element is
//     stationary, so it snaps once) and prevents a paused-ahead local element
//     from resuming out of sync.
//   - Play state: follow the receiver, believing its CLOCK over its FLAG.
//     remotePlayer.isPaused reads false in cases where the receiver is really
//     stopped; a clock that hasn't moved for CAST_STALL_TIMEOUT_MS is stopped.
//     Explicit transitions (play/pause/seek) reset that window via
//     resetRemoteClockGrace() so a fresh resume isn't misread as a stall.
//
//   TRANSPORT IS BIDIRECTIONAL:
//   The reconciler alone would make the sender's native <audio> controls
//   read-only while casting — pausing there was undone within 500ms, because
//   the reconciler saw the receiver still playing and resumed the local copy.
//   So audioEl's own play/pause events feed mirrorLocalTransportToRemote(),
//   which forwards user intent to the receiver as a command. The receiver
//   changes state and the reconciler follows, so the receiver remains the
//   single source of truth and the loop stays one-directional per event.
//
//   Distinguishing user intent from the reconciler's own writes is what
//   markProgrammaticTransport() is for: media elements fire play/pause
//   asynchronously, so a synchronous flag cannot cover them and a short
//   time window (TRANSPORT_ECHO_WINDOW_MS) is used instead. Every
//   programmatic transport change must be marked, or it will echo back to the
//   receiver and toggle it into the wrong state.
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
// ?verbose=1      → emit DEBUG-level traces (see castLogDebug)
// ?receiverAppId=XXXX → override Cast receiver app ID
const urlParams = new URLSearchParams(window.location.search);
const receiverMode = urlParams.get("mode") === "receiver" || urlParams.get("receiver") === "1";
const castDebugEnabled = urlParams.get("castDebug") === "1";
// Verbose tracing is opt-in and sticky via localStorage, so it can be turned on
// for a receiver that is already running (the TV's URL is fixed at the Cast
// console). Off by default on purpose: the server accepts a bounded number of
// client log entries per minute and the log file rotates at a few MB, so
// shipping every trace all the time would push out the events worth keeping.
const verboseLoggingEnabled =
  urlParams.get("verbose") === "1" ||
  (typeof localStorage !== "undefined" && localStorage.getItem("echoaiVerbose") === "1");

// ── Cast Debug Logger ────────────────────────────────────────────────────────
// On-screen debug panel for diagnosing Cast issues on Chromecast devices where
// there are no browser DevTools.  Activated by ?castDebug=1 or long-pressing
// the Play/Pause button (1.6s) in fullscreen/receiver mode.
const CAST_LOG_MAX = 200;             // Max retained log entries (circular buffer)
const castLogEntries = [];            // Ring buffer of {ts, level, msg} log entries
let castDebugPanelEl = null;          // Root DOM element of the debug panel (created lazily)
let castDebugPanelBodyEl = null;      // Scrollable body div inside the debug panel

let castDebugFullscreen = false;      // Whether the debug panel is currently shown fullscreen

// ── Server log shipping ──────────────────────────────────────────────────────
// castLog() entries are batched and POSTed to /api/logs/client so they land in
// the Pi's log file alongside server logs and are viewable at /logs. This is
// the only way to see what the Chromecast receiver did — a TV has no DevTools.
//
// Bounded on purpose: a flush is capped at the server's per-request limit, the
// pending queue is capped so a server outage can't grow it without limit, and
// failures are swallowed. Logging must never break playback or recurse.
const LOG_SHIP_INTERVAL_MS = 3000;    // Batch window — keeps requests off the hot path
const LOG_SHIP_MAX_BATCH = 50;        // Must not exceed the server's CLIENT_LOG_MAX_ENTRIES
const LOG_SHIP_MAX_PENDING = 200;     // Queue ceiling while the server is unreachable
let logShipQueue = [];
let logShipTimer = null;
let logShipInFlight = false;

/** Queue one entry for the next flush. Never throws — callers are log calls. */
function shipLogEntry(level, msg, ts) {
  // The client's own timestamp travels with the entry. Without it every line in
  // a batch inherits the server's ingest time, which collapses a 4-second
  // sequence into 9 milliseconds and makes timing bugs unreadable.
  logShipQueue.push({ level, msg, ts });
  if (logShipQueue.length > LOG_SHIP_MAX_PENDING) {
    logShipQueue = logShipQueue.slice(-LOG_SHIP_MAX_PENDING);
  }
  if (!logShipTimer) {
    logShipTimer = setTimeout(flushLogQueue, LOG_SHIP_INTERVAL_MS);
  }
}

/**
 * POST one batch. Drops the batch on failure rather than retrying — a retry
 * loop against a down server is exactly the kind of unbounded work this file
 * must not do, and losing debug lines is cheaper than wedging the UI.
 */
async function flushLogQueue() {
  logShipTimer = null;
  if (logShipInFlight || !logShipQueue.length) return;

  const batch = logShipQueue.splice(0, LOG_SHIP_MAX_BATCH);
  logShipInFlight = true;
  try {
    const headers = { "Content-Type": "application/json" };
    // The receiver has no cookies — it authenticates with its cast token.
    if (receiverAuthToken) headers["X-Cast-Token"] = receiverAuthToken;
    await fetch("/api/logs/client", {
      method: "POST",
      headers,
      body: JSON.stringify({
        source: receiverMode ? "receiver" : "sender",
        entries: batch,
      }),
    });
  } catch {
    // Deliberately silent: console.* here would recurse through castLog().
  } finally {
    logShipInFlight = false;
    if (logShipQueue.length) {
      logShipTimer = setTimeout(flushLogQueue, LOG_SHIP_INTERVAL_MS);
    }
  }
}

/**
 * Lazily create the on-screen debug panel DOM.  Called on first castLog() when
 * ?castDebug=1 is set, or when the user long-presses the Play/Pause button.
 * Idempotent — returns immediately if the panel already exists.
 */
function _ensureCastDebugPanel() {
  if (castDebugPanelEl) return;
  castDebugPanelEl = document.createElement("div");
  castDebugPanelEl.id = "castDebugPanel";
  castDebugPanelEl.className = "cast-debug-panel";

  // Header bar with title and action buttons.
  const header = document.createElement("div");
  header.className = "cast-debug-header";
  header.innerHTML =
    '<span style="font-weight:bold;color:#0f0">🔊 Cast Debug</span>';
  const btnGroup = document.createElement("span");

  // "Copy" button — copies all log entries to clipboard as plain text.
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy";
  copyBtn.tabIndex = -1;  // Exclude from D-pad tab order on Chromecast
  copyBtn.className = "cast-debug-btn";
  copyBtn.addEventListener("click", () => {
    const text = castLogEntries.map((e) => `[${e.ts}] ${e.level} ${e.msg}`).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  });

  // "Clear" button — empties both the in-memory buffer and the panel DOM.
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear";
  clearBtn.tabIndex = -1;
  clearBtn.className = "cast-debug-btn";
  clearBtn.addEventListener("click", () => {
    castLogEntries.length = 0;
    if (castDebugPanelBodyEl) castDebugPanelBodyEl.innerHTML = "";
  });

  // "✕" close button — hides the panel without destroying it.
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.tabIndex = -1;
  closeBtn.className = "cast-debug-btn cast-debug-close-btn";
  closeBtn.addEventListener("click", () => {
    hideCastDebugPanel();
  });

  // Assemble header: [title] [Copy] [Clear] [✕]
  btnGroup.appendChild(copyBtn);
  btnGroup.appendChild(clearBtn);
  btnGroup.appendChild(closeBtn);
  header.appendChild(btnGroup);
  castDebugPanelEl.appendChild(header);

  // Scrollable body where individual log lines are appended.
  castDebugPanelBodyEl = document.createElement("div");
  castDebugPanelBodyEl.className = "cast-debug-body";
  castDebugPanelEl.appendChild(castDebugPanelBodyEl);
  document.body.appendChild(castDebugPanelEl);
}

/**
 * Show the debug panel in fullscreen overlay mode.
 * Back-fills any log entries that were captured before the panel was opened.
 */
function showCastDebugPanel() {
  _ensureCastDebugPanel();
  castDebugFullscreen = true;
  castDebugPanelEl.classList.add("fullscreen");
  castDebugPanelEl.style.display = "";
  // Back-fill existing log entries into the panel body (only if empty,
  // i.e. the panel was just created or was cleared).
  if (castDebugPanelBodyEl && castDebugPanelBodyEl.children.length === 0) {
    for (const entry of castLogEntries) {
      const line = document.createElement("div");
      const color = entry.level === "ERROR" ? "#f44" : entry.level === "WARN" ? "#fa0" : entry.level === "OK" ? "#4f4" : "#0f0";
      line.style.cssText = `color:${color};word-break:break-all;border-bottom:1px solid #111;padding:1px 0;`;
      line.textContent = `${entry.ts} ${entry.level} ${entry.msg}`;
      castDebugPanelBodyEl.appendChild(line);
    }
  }
  // Auto-scroll to the latest entry.
  castDebugPanelEl.scrollTop = castDebugPanelEl.scrollHeight;
  castLog("INFO", "debug panel opened (fullscreen)");
}

/** Hide the debug panel (keeps DOM + log buffer intact for re-opening). */
function hideCastDebugPanel() {
  if (!castDebugPanelEl) return;
  castDebugFullscreen = false;
  castDebugPanelEl.classList.remove("fullscreen");
  castDebugPanelEl.style.display = "none";
  castLog("INFO", "debug panel closed");
}

/** Toggle debug panel visibility — called by long-press on Play/Pause. */
function toggleCastDebugPanel() {
  _ensureCastDebugPanel();
  if (castDebugFullscreen) {
    hideCastDebugPanel();
  } else {
    showCastDebugPanel();
  }
}

/**
 * Central logging function for all Cast-related activity.
 * - Always logs to browser console (error/warn/log based on level).
 * - Stores entries in a bounded ring buffer (CAST_LOG_MAX entries).
 * - When the debug panel is active (?castDebug=1 or long-press toggle),
 *   also appends a colour-coded line to the on-screen panel.
 *
 * Levels: "ERROR" (red), "WARN" (orange), "OK" (green), "INFO" (lime).
 *
 * @param {string} level - Log level: "ERROR", "WARN", "OK", or "INFO".
 * @param {...*} args - Values to log (objects are JSON-stringified).
 */
function castLog(level, ...args) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  const tag = `[Cast/${level}]`;

  // Route to the appropriate console method for browser DevTools filtering.
  if (level === "ERROR") {
    console.error(tag, ...args);
  } else if (level === "WARN") {
    console.warn(tag, ...args);
  } else {
    console.log(tag, ...args);
  }

  // Append to the bounded ring buffer (drop oldest when full).
  castLogEntries.push({ ts, level, msg });
  if (castLogEntries.length > CAST_LOG_MAX) castLogEntries.shift();

  // Ship to the server so Chromecast-side failures are diagnosable at /logs —
  // the receiver runs on a TV with no DevTools and no way to read its console.
  shipLogEntry(level, msg, ts);

  // If the on-screen debug panel is active, render the entry there too.
  if (castDebugEnabled || castDebugFullscreen) {
    _ensureCastDebugPanel();
    const line = document.createElement("div");
    const color = level === "ERROR" ? "#f44" : level === "WARN" ? "#fa0" : level === "OK" ? "#4f4" : "#0f0";
    line.style.cssText = `color:${color};word-break:break-all;border-bottom:1px solid #111;padding:1px 0;`;
    line.textContent = `${ts} ${level} ${msg}`;
    castDebugPanelBodyEl.appendChild(line);
    castDebugPanelEl.scrollTop = castDebugPanelEl.scrollHeight;
  }
}

/**
 * DEBUG-level trace. No-op unless verbose logging is enabled (?verbose=1 or
 * localStorage echoaiVerbose=1).
 *
 * Use this for anything high-frequency or fine-grained — per-event traces,
 * highlight movement, buffering detail. Reserve castLog() for state changes and
 * decisions, which must always be visible. The split exists because the server
 * caps client log entries per minute and the log file rotates within a few MB:
 * shipping every trace unconditionally would evict the events worth keeping.
 */
function castLogDebug(...args) {
  if (!verboseLoggingEnabled) return;
  castLog("DEBUG", ...args);
}

/** Compact one-line description of an episode load, for the heartbeat. */
function _mediaSummary() {
  return `ep=${currentEpisodeId || "-"} segs=${currentSegments.length} words=${currentWords.length}`;
}

/**
 * Periodic state snapshot.
 *
 * The single most useful thing in these logs: transitions tell you WHAT
 * changed, a heartbeat tells you the state at a known instant, so a timeline
 * can be reconstructed after the fact instead of inferred from gaps. Low
 * frequency (CAST_HEARTBEAT_MS) so it costs almost nothing against the rate
 * limit, and always at INFO so it survives without verbose mode.
 */
function logSyncHeartbeat() {
  const local = `local=${audioEl.currentTime.toFixed(1)}/${(audioEl.duration || 0).toFixed(0)}s` +
    ` ${audioEl.paused ? "paused" : "playing"}${audioEl.muted ? " muted" : ""}`;

  if (receiverMode) {
    castLog("INFO", `hb receiver: ${local} ${_mediaSummary()}` +
      ` seg=${fsActiveSegmentIndex} word=${fsActiveWordIndex}` +
      ` auth=${receiverAuthToken ? "yes" : "NO"} pinned=${receiverPausedAtTime ?? "-"}`);
    return;
  }

  if (!_isCasting()) {
    castLog("INFO", `hb sender: ${local} ${_mediaSummary()} casting=no`);
    return;
  }

  const remoteTime = remotePlayer ? remotePlayer.currentTime : NaN;
  const drift = audioEl.currentTime - remoteTime;
  castLog("INFO", `hb sender: ${local} ${_mediaSummary()} casting=yes` +
    ` remote=${remoteTime.toFixed(1)}s ${remotePlayer.isPaused ? "paused" : "playing"}` +
    ` drift=${drift.toFixed(2)}s moving=${remoteIsMoving(Date.now())}` +
    ` transition=${isEpisodeTransitionActive(Date.now())}`);
}

// ─────────────────────────────────────────────────────────────────────────────

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
// Position audioEl held when the receiver was paused, or null if none is
// pinned. The Cast framework resumes from its own clock, which keeps running
// across a pause, so without this the transcript restarts ahead of the audio.
let receiverPausedAtTime = null;
// Largest correction we will apply on resume. Above this the gap is a real
// seek we somehow missed, and silently yanking playback backwards would be
// worse than the drift.
const RECEIVER_RESUME_MAX_CORRECTION_SEC = 30;
/**
 * How long the receiver will hold playback waiting for a new episode's
 * transcript. Long enough for a cold spaCy-backed request on a Pi, short enough
 * that a broken transcript endpoint degrades to audio-only rather than silence.
 */
const RECEIVER_TRANSCRIPT_WAIT_MS = 5000;

// ── Bidirectional Cast sync state (sender side) ──────────────────────────────
// These are only used on the sender to track the receiver's media state.
let remotePlayer = null;              // cast.framework.RemotePlayer — tracks receiver state
let remotePlayerController = null;    // cast.framework.RemotePlayerController — sends commands
let castTimeSyncInterval = null;      // 500ms drift correction interval ID
let castTokenRefreshInterval = null;  // Periodic auth token refresh interval ID
// [eventType, handler] pairs registered on remotePlayerController, so teardown
// can detach them. Without this every re-setup leaked a full set of listeners.
let castSyncListeners = [];

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
 * Seek to a time position. This is a COMMAND, not reconciliation: the user
 * chose this position, so we drive both clocks to it rather than converging
 * one on the other. reconcileLocalToRemote() takes over again afterwards.
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
    // Marked: this play is ours, and the explicit remote resume below already
    // covers the receiver. Without the mark the mirror would fire too and the
    // two toggles would cancel out, leaving the receiver paused.
    markProgrammaticTransport(false);
    audioEl.play().catch((err) => {
      castLog("WARN", "_seekTo play failed:", err.message);
    });
  }
  if (_isCasting()) {
    castLog("INFO", "_seekTo → Chromecast:", time.toFixed(1), "s, autoPlay:", autoPlay);
    remotePlayer.currentTime = time;
    remotePlayerController.seek();
    // Resume the remote too, or the local element advances against a stopped
    // receiver and the reconciler drags it back every cycle.
    if (autoPlay && remotePlayer.isPaused) {
      remotePlayerController.playOrPause();
    }
    // The seek is authoritative — don't let the pre-seek clock reading make
    // the receiver look stalled while its media status catches up.
    resetRemoteClockGrace(Date.now());
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
  // Never resume a parked element. The sender is deliberately stopped during a
  // cast handover or episode change until the receiver confirms the new media;
  // resuming here would undo the park and let it run ahead again. Enforced in
  // this one function so every caller is covered, present and future.
  if (isEpisodeTransitionActive(Date.now())) {
    castLogDebug("_ensureLocalMutedPlayback: suppressed — handover in progress");
    return;
  }
  audioEl.muted = true;
  if (audioEl.paused) {
    // The only place local playback is started programmatically — marking it
    // here keeps the resulting 'play' event from being mirrored back as user
    // intent, whichever caller triggered it.
    markProgrammaticTransport(false);
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
  // The Chromecast never loads /logs, and a focusable link the D-pad could
  // reach would strand the TV on a page it cannot navigate back from.
  const logsLinkEl = document.getElementById("logsLink");
  if (logsLinkEl) logsLinkEl.remove();
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

// Google's Default Media Receiver. It is Google-hosted and never loads our page,
// so under it there is no transcript UI and nothing listening on CAST_NAMESPACE.
// Only useful to prove a device is reachable — see docs/CHROMECAST.md (C-1).
const DEFAULT_MEDIA_RECEIVER_APP_ID = "CC1AD845";

function getCastReceiverAppId() {
  // Priority: URL query param > localStorage override > server config > default.
  const fromQuery = new URLSearchParams(window.location.search).get("receiverAppId");
  if (fromQuery) { castLog("INFO", "appId from query:", fromQuery); return fromQuery; }
  const fromStorage = localStorage.getItem("castReceiverAppId");
  if (fromStorage) { castLog("INFO", "appId from localStorage:", fromStorage); return fromStorage; }
  if (runtimeConfig.cast_receiver_app_id) { castLog("INFO", "appId from config:", runtimeConfig.cast_receiver_app_id); return runtimeConfig.cast_receiver_app_id; }
  castLog("ERROR",
    "no Cast receiver app id configured — falling back to the Default Media Receiver. " +
    "Audio may play but the transcript UI and auth channel will NOT work. " +
    "Register a Custom Web Receiver and set TRANSCRIPT_VIEWER_CAST_RECEIVER_APP_ID.");
  return DEFAULT_MEDIA_RECEIVER_APP_ID;
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

  // Minting a token is a network round trip, and this function is never
  // awaited. Switching episodes quickly could therefore let an older call
  // finish last and load the PREVIOUS episode onto the receiver — the sender
  // and receiver then disagreed about which episode was playing.
  const loadToken = activeEpisodeLoadToken;
  const isStale = () => loadToken !== activeEpisodeLoadToken;

  castLog("INFO", "loading media on Cast session:", meta.id, meta.mediaUrl,
    "startTime:", startTime.toFixed ? startTime.toFixed(2) : startTime, "token:", loadToken);

  let mediaUrl = meta.mediaUrl;
  try {
    const token = await requestCastSessionToken(meta.id);
    if (isStale()) {
      castLog("INFO", `abandoning stale cast load for ${meta.id} (token ${loadToken})`);
      return;
    }
    if (token) {
      mediaUrl = `${meta.mediaUrl}${meta.mediaUrl.includes("?") ? "&" : "?"}rt=${encodeURIComponent(token)}`;
      castLog("INFO", "cast token appended to media URL");
    }
  } catch (err) {
    castLog("ERROR", "cast token request failed:", err.message);
    statusTextEl.textContent = err.message;
    endEpisodeTransition("cast token failed");
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
    () => {
      castLog("OK", `media loaded on receiver: ${meta.id} @ ${startTime.toFixed ? startTime.toFixed(2) : startTime}s`);
      if (isStale()) {
        castLog("INFO", "load completed for a superseded episode — leaving sync suspended");
        return;
      }
      // Both ends now describe the same media — safe to reconcile again. The
      // first reconcile aligns the parked local element to the receiver before
      // resuming it, which is what makes the handover seamless.
      endEpisodeTransition("loadMedia ok");
    },
    (err) => {
      castLog("ERROR", "loadMedia failed:", err);
      // Do not strand sync suspended on a failed load; the timeout would
      // eventually clear it, but the receiver is still on the old episode
      // and reconciling against that is correct.
      endEpisodeTransition("loadMedia failed");
    }
  );
}

// ── Cast sync: local/remote clock reconciliation (sender side) ───────────────
//
// See "ONE RECONCILER, MANY TRIGGERS" in the file header before editing.
// reconcileLocalToRemote() owns audioEl's clock and play state while casting;
// new sync triggers call it rather than touching audioEl themselves.

/**
 * Max tolerated gap between the local muted audioEl and the receiver, in seconds.
 * Below this the transcript highlight is visually indistinguishable from correct;
 * above it, snap. Applies whether the remote is playing or paused.
 */
const CAST_DRIFT_TOLERANCE_SEC = 0.5;

/** How often the sender polls the receiver's clock. */
const CAST_SYNC_INTERVAL_MS = 500;

/**
 * How long the receiver's clock may sit still before we call it stopped.
 * Three poll cycles — long enough to survive one dropped media status,
 * short enough that a stuck receiver can't drag the local element with it.
 */
const CAST_STALL_TIMEOUT_MS = 1500;

/**
 * How long after the reconciler touches the local transport its own play/pause
 * event still counts as an echo rather than user intent. The media element
 * fires those events asynchronously, so a synchronous flag cannot cover them.
 */
const TRANSPORT_ECHO_WINDOW_MS = 250;

/**
 * How long reconciliation stays suspended after an episode change is initiated.
 *
 * During a changeover the two ends briefly describe DIFFERENT media: the sender
 * has already switched to the new episode at 0s while the receiver is still
 * reporting the old one at, say, 500s. Reconciling across that gap snapped the
 * new episode straight to the old position — the single worst desync in this
 * flow. The window ends early as soon as the receiver confirms the new load.
 */
const CAST_EPISODE_TRANSITION_MS = 8000;

/**
 * Minimum gap between position snaps.
 *
 * Every snap seeks the local element, a seek forces a re-buffer, and while it
 * re-buffers the local clock stalls while the receiver's keeps running — so the
 * drift that triggered the snap comes straight back. Field logs showed exactly
 * that loop, oscillating between 38.9s and 40.0s and dragging the transcript
 * (and its lazy translations) around with it. Snapping is a correction of last
 * resort, not something to do four times a second.
 */
const CAST_MIN_SNAP_INTERVAL_MS = 3000;

/**
 * Drift above which we give up nudging and seek outright.
 *
 * Seeking is violent: it empties the buffer, fires `waiting`, and makes the
 * browser's native audio widget flash between play and paused — the flicker
 * reported from the field. It is the right tool only for a genuine jump (a user
 * seek, an episode change), never for the second or so of slippage a muted
 * clock naturally accumulates.
 */
const CAST_SEEK_THRESHOLD_SEC = 3;

/**
 * Playback-rate nudge used to close small drift instead of seeking.
 *
 * The local element is muted, so speeding it up or slowing it down by 5% is
 * completely inaudible, costs no buffering, and converges a 1s error in about
 * 20s. This is the standard way to slave one clock to another without glitching.
 */
const CAST_NUDGE_RATE = 0.05;

/**
 * How long after sending a transport command the reconciler leaves play state
 * alone. The receiver needs a round trip to report the new state; without this
 * the very next poll sees "remote still playing, local paused" and undoes the
 * user's pause before the command has even landed.
 */
const TRANSPORT_COMMAND_SETTLE_MS = 2000;

/**
 * Heartbeat period. Deliberately slow: at 10s each client contributes 6 log
 * entries a minute, a rounding error against the server's per-minute cap, while
 * still giving enough resolution to reconstruct a playback timeline.
 */
const CAST_HEARTBEAT_MS = 10000;

// Movement tracker for the receiver's clock. remotePlayer.isPaused is trusted
// when true, but it reads false in cases where the receiver is genuinely
// stopped, so we corroborate it with "has the clock actually moved lately".
let lastRemoteTime = -1;
let lastRemoteMoveAt = 0;
// When the last position snap happened, enforcing CAST_MIN_SNAP_INTERVAL_MS.
let lastSnapAt = 0;

function castShouldSnap(localTime, remoteTime) {
  return Math.abs(localTime - remoteTime) > CAST_DRIFT_TOLERANCE_SEC;
}

/**
 * Record the receiver's clock position. Extends the movement window whenever
 * the clock advances; call on every sync trigger.
 */
function noteRemoteClock(remoteTime, now) {
  if (remoteTime !== lastRemoteTime) {
    lastRemoteTime = remoteTime;
    lastRemoteMoveAt = now;
  }
}

/**
 * Give the clock a fresh grace window. Called on an explicit state change
 * (session start, play/pause) so that the moment after a resume — flag says
 * playing, clock hasn't ticked yet — is read as playing rather than stalled.
 */
function resetRemoteClockGrace(now) {
  lastRemoteMoveAt = now;
}

/** Is the receiver actually advancing, per its clock rather than its flag? */
function remoteIsMoving(now) {
  return now - lastRemoteMoveAt < CAST_STALL_TIMEOUT_MS;
}

// ── Local transport → remote ────────────────────────────────────────────────
//
// The reconciler makes the local element follow the receiver. That alone makes
// the sender's NATIVE audio controls read-only while casting: pausing there was
// undone within 500ms, because the reconciler saw the receiver still playing
// and dutifully resumed the local copy.
//
// So play/pause is bidirectional: a transport change the reconciler did NOT
// cause is user intent, and gets sent to the receiver as a command. The
// receiver changes state, and the reconciler brings the local element into line
// as usual — the receiver stays the single source of truth.

let lastProgrammaticTransportAt = 0;
// The play state the reconciler last asked the local element to be in.
// Comparing against this is how a user's play/pause is told apart from our own,
// and it is deterministic — the earlier time-window approach silently swallowed
// real pauses whenever buffering had made the reconciler act in the last 250ms,
// which on a Pi was most of the time.
let commandedLocalPaused = null;

/** Mark a transport change as ours, so its event is not mistaken for the user. */
function markProgrammaticTransport(pausedState) {
  lastProgrammaticTransportAt = Date.now();
  if (pausedState !== undefined) commandedLocalPaused = pausedState;
}

// Set when we send a transport command to the receiver; until it expires the
// reconciler must not "correct" the play state it is still waiting on.
let transportCommandUntil = 0;

function isTransportCommandPending(now) {
  return now < transportCommandUntil;
}

// ── Episode transitions ─────────────────────────────────────────────────────
//
// While an episode change is in flight the sender and receiver describe
// different media, so their clocks are not comparable and must not be
// reconciled. See CAST_EPISODE_TRANSITION_MS.

let castTransitionUntil = 0;
// True while we are waiting for OUR LoadRequest to be confirmed by the receiver.
// When false, the receiver switched first and the local element catching up is
// the thing we are waiting for instead.
let castTransitionAwaitsLoadMedia = false;

/** Suspend reconciliation — call when an episode change is initiated. */
function beginEpisodeTransition(reason, awaitsLoadMedia) {
  castTransitionUntil = Date.now() + CAST_EPISODE_TRANSITION_MS;
  castTransitionAwaitsLoadMedia = awaitsLoadMedia;
  castLog("INFO", `episode transition started (${reason}) — sync suspended`);
}

/** Resume reconciliation against the new media, with a clean clock tracker. */
function endEpisodeTransition(reason) {
  if (!castTransitionUntil) return;
  castTransitionUntil = 0;
  castTransitionAwaitsLoadMedia = false;
  lastRemoteTime = -1;
  resetRemoteClockGrace(Date.now());
  castLog("INFO", `episode transition finished (${reason}) — sync resumed`);
}

function isEpisodeTransitionActive(now) {
  return now < castTransitionUntil;
}

/**
 * Park the sender's local element while the receiver takes over or catches up.
 *
 * Starting a cast — and switching episode mid-cast — is a handover, not a fork.
 * Previously the sender kept playing (muted) through the token mint and the
 * LOAD round trip, so by the time the receiver reported in it was a second or
 * more ahead, and the reconciler dragged it backwards: the visible "steps far
 * back". Parking makes the handover position stable, and for a cast start it is
 * also simply what the user expects — playback moves to the TV.
 *
 * Reuses the episode-transition window, which already suspends the whole
 * reconciler, so nothing touches the local clock until the receiver confirms.
 * The first reconcile after that aligns the parked element before resuming it.
 */
function parkSenderForHandover(reason) {
  beginEpisodeTransition(reason, true);
  if (!audioEl.paused) {
    castLog("INFO", `${reason}: parking sender at ${audioEl.currentTime.toFixed(2)}s`);
    markProgrammaticTransport(true);
    audioEl.pause();
  }
}

/** Cast session start: mute the sender and park it until the receiver has media. */
function beginCastHandover() {
  _muteSenderForCast();
  parkSenderForHandover("cast handover");
}

/**
 * Should a local play/pause be forwarded to the receiver?
 *
 * Pure, so the logic is testable without a Cast SDK. `commanded` is the state
 * the reconciler last asked for: if the element now matches it, this event is
 * our own change echoing back. If it differs, the user did it. Comparing intent
 * rather than timing is what makes this reliable while buffering churns.
 */
function shouldMirrorTransport(localPaused, remotePaused, commanded) {
  if (localPaused === commanded) return false;   // our own change echoing back
  return localPaused !== remotePaused;           // already agree → nothing to send
}

/** Forward a user-initiated local play/pause to the receiver. */
function mirrorLocalTransportToRemote() {
  if (receiverMode || !_isCasting()) return;
  if (!remotePlayer || remotePlayer.duration <= 0) return;

  if (!shouldMirrorTransport(audioEl.paused, remotePlayer.isPaused, commandedLocalPaused)) return;

  castLog("INFO", `transport: mirroring local ${audioEl.paused ? "pause" : "play"} to receiver`);
  remotePlayerController.playOrPause();
  // The user's intent is now the commanded state — and hold the reconciler off
  // the play state until the receiver has had time to report back.
  commandedLocalPaused = audioEl.paused;
  transportCommandUntil = Date.now() + TRANSPORT_COMMAND_SETTLE_MS;
  resetRemoteClockGrace(Date.now());
}

/**
 * THE single owner of local/remote playback reconciliation.
 *
 * Nothing else may write audioEl.currentTime or toggle audioEl play state while
 * casting. Every sync trigger (pause events, time events, the poll interval)
 * funnels here, so there is exactly one place where the policy lives and
 * exactly one place a sync regression can hide.
 *
 * Policy:
 * - Position: converge on the receiver whenever drift exceeds tolerance,
 *   playing OR paused. Correcting while paused is free — the element is
 *   stationary, so it snaps once and settles rather than flickering — and it
 *   is what stops a paused-ahead local element from resuming out of sync.
 * - Play state: follow the receiver, believing its clock over its flag.
 *
 * @param {string} reason - Trigger name, for the debug log only.
 */
/**
 * How the local clock should be brought back to the receiver.
 *
 * Pure so the policy is testable without a media element.
 *  - "none"  : inside tolerance, leave it entirely alone
 *  - "nudge" : small drift while playing — adjust playbackRate, silent and
 *              buffer-free
 *  - "seek"  : a real jump, or any correction while paused
 *
 * A paused element cannot be nudged: playbackRate only has an effect during
 * playback. So while paused, seeking is the only option — and it is harmless
 * there, because a stopped clock cannot feed the seek/re-buffer loop that made
 * seeking the wrong choice during playback.
 */
function driftCorrection(localTime, remoteTime, localPaused) {
  const magnitude = Math.abs(localTime - remoteTime);
  if (magnitude <= CAST_DRIFT_TOLERANCE_SEC) return "none";
  if (localPaused) return "seek";
  if (magnitude >= CAST_SEEK_THRESHOLD_SEC) return "seek";
  return "nudge";
}

/** Playback rate that closes `drift` (local minus remote) without seeking. */
function nudgeRateFor(localTime, remoteTime) {
  // Ahead of the receiver → run slower; behind → run faster.
  return localTime > remoteTime ? 1 - CAST_NUDGE_RATE : 1 + CAST_NUDGE_RATE;
}

function setLocalPlaybackRate(rate) {
  if (audioEl.playbackRate === rate) return;
  audioEl.playbackRate = rate;
  castLogDebug(`sync: playbackRate → ${rate}`);
}

function reconcileLocalToRemote(reason) {
  if (receiverMode || !_isCasting()) return;
  if (!remotePlayer || remotePlayer.duration <= 0) return;

  const now = Date.now();
  // Mid-changeover the two ends describe different media — comparing their
  // clocks would snap the new episode to the old one's position.
  if (isEpisodeTransitionActive(now)) return;

  const remoteTime = remotePlayer.currentTime;
  noteRemoteClock(remoteTime, now);

  // Position. Nudge for small drift, seek only for a genuine jump — see
  // driftCorrection(). Seeking to fix a second of slippage emptied the buffer
  // on every correction, which is what made the audio widget flicker.
  const settling = audioEl.seeking || audioEl.readyState < 3; // < HAVE_FUTURE_DATA
  const correction = settling
    ? "none"
    : driftCorrection(audioEl.currentTime, remoteTime, audioEl.paused);

  // The cooldown exists to break the seek→buffer→drift loop, which only runs
  // while playing. A paused element is stationary, so its correction is a
  // one-off and must not be deferred.
  const seekAllowed = audioEl.paused || now - lastSnapAt >= CAST_MIN_SNAP_INTERVAL_MS;

  if (correction === "seek" && seekAllowed) {
    const drift = audioEl.currentTime - remoteTime;
    castLog("INFO", `sync[${reason}]: seek ${drift.toFixed(1)}s → ${remoteTime.toFixed(1)}s`);
    lastSnapAt = now;
    setLocalPlaybackRate(1);
    audioEl.currentTime = remoteTime;
  } else if (correction === "seek") {
    castLogDebug(`sync[${reason}]: seek deferred by cooldown` +
      ` (drift ${(audioEl.currentTime - remoteTime).toFixed(2)}s)`);
  } else if (correction === "nudge") {
    setLocalPlaybackRate(nudgeRateFor(audioEl.currentTime, remoteTime));
  } else if (!settling) {
    setLocalPlaybackRate(1);
  }

  // Play state. Left alone while a transport command we sent is still in
  // flight, or the very next poll undoes the user's own pause.
  if (isTransportCommandPending(now)) {
    castLogDebug(`sync[${reason}]: transport command pending — play state held`);
    return;
  }

  const shouldPlay = !remotePlayer.isPaused && remoteIsMoving(now);
  if (shouldPlay && audioEl.paused) {
    castLog("INFO", `sync[${reason}]: resuming local muted playback`);
    _ensureLocalMutedPlayback();
  } else if (!shouldPlay && !audioEl.paused) {
    castLog("INFO", `sync[${reason}]: pausing local (remote stopped)`);
    markProgrammaticTransport(true);
    audioEl.pause();
  } else {
    // Nothing to do, but record what state we believe the element should be in
    // so a later user action is recognisable as a departure from it.
    commandedLocalPaused = !shouldPlay;
  }
}

/**
 * Set up RemotePlayer + RemotePlayerController so the sender tracks receiver
 * media state, wire the reconciler's triggers, and listen for custom namespace
 * messages (episode changes) from the receiver.
 */
function setupCastSync(session) {
  teardownCastSync();
  if (!window.cast || !window.cast.framework) return;

  remotePlayer = new cast.framework.RemotePlayer();
  remotePlayerController = new cast.framework.RemotePlayerController(remotePlayer);
  castLog("INFO", "RemotePlayer + Controller created");

  // Start optimistic: assume the receiver is live until its clock proves
  // otherwise, so the grace window doesn't suppress the initial playback.
  lastRemoteTime = -1;
  resetRemoteClockGrace(Date.now());

  // Kick-start local muted playback so the sender UI tracks position from the
  // moment casting begins. Suppressed automatically during a handover — see
  // _ensureLocalMutedPlayback().
  _ensureLocalMutedPlayback();

  // Every trigger below does the same thing: report to the reconciler.
  // Registered through onRemote() so teardown can actually detach them.
  const onRemote = (typeName, handler) => {
    const type = cast.framework.RemotePlayerEventType[typeName];
    if (!type) { castLog("WARN", "RemotePlayerEventType missing:", typeName); return; }
    remotePlayerController.addEventListener(type, handler);
    castSyncListeners.push([type, handler]);
  };

  onRemote("IS_PAUSED_CHANGED", () => {
    castLog("INFO", "remote IS_PAUSED_CHANGED — paused:", remotePlayer.isPaused);
    // An explicit transition is trustworthy — restart the grace window so a
    // resume isn't misread as a stall in the moment before the clock ticks.
    resetRemoteClockGrace(Date.now());
    reconcileLocalToRemote("pause-changed");
  });

  onRemote("CURRENT_TIME_CHANGED", () => reconcileLocalToRemote("time-changed"));

  castTimeSyncInterval = setInterval(
    () => reconcileLocalToRemote("poll"),
    CAST_SYNC_INTERVAL_MS
  );

  // The receiver can vanish without a clean SESSION_ENDED (app crash, device
  // reboot, network drop). Without this the sender keeps a dead castSession,
  // stays muted, and silently mirrors every seek into the void.
  onRemote("IS_CONNECTED_CHANGED", () => {
    if (remotePlayer && remotePlayer.isConnected) return;
    castLog("WARN", "remote disconnected — tearing down cast sync");
    castSession = null;
    teardownCastSync();
    _unmuteSenderForCast();
    updateCastButtonState();
  });

  // Listen for custom namespace messages from the receiver (e.g. episode changes).
  session.addMessageListener(CAST_NAMESPACE, (_namespace, messageStr) => {
    try {
      const msg = typeof messageStr === "string" ? JSON.parse(messageStr) : messageStr;
      castLog("INFO", "sender received Cast message — type:", msg.type);
      // The receiver announces itself once its namespace listener is live.
      // This closes the race where our initial 500ms-delayed auth push arrived
      // before the receiver could hear it (previously unrecoverable until the
      // next refresh tick, i.e. minutes of 401s on the TV).
      if (msg.type === "ready") {
        castLog("INFO", "receiver announced ready — re-sending auth token");
        void _mintAndSendCastToken(session);
        return;
      }
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
  // Detach listeners explicitly. Dropping the controller reference is NOT
  // enough — the framework holds its own reference, so every re-setup left a
  // live set behind and each Cast event was then handled two or three times
  // over. That is what produced the repeated IS_PAUSED_CHANGED lines and the
  // pairs of opposing snaps in the same millisecond.
  if (remotePlayerController && castSyncListeners.length) {
    castLog("INFO", `detaching ${castSyncListeners.length} cast listeners`);
    for (const [type, handler] of castSyncListeners) {
      try {
        remotePlayerController.removeEventListener(type, handler);
      } catch (err) {
        castLog("WARN", "removeEventListener failed:", err.message);
      }
    }
  }
  castSyncListeners = [];
  remotePlayer = null;
  remotePlayerController = null;
  // A nudge must never outlive the cast session, or local playback runs 5% off
  // pitch for the rest of the session.
  if (!receiverMode) audioEl.playbackRate = 1;
  // Reset the clock tracker — a later session must not inherit this one's
  // movement window and mistake a cold receiver for a live one.
  lastRemoteTime = -1;
  lastRemoteMoveAt = 0;
  castLog("INFO", "Cast sync torn down");
}
/**
 * Attach the sender to a session that already has media loaded (resumed, or
 * auto-joined before our listeners existed).
 *
 * setupCastSync() clears the token refresh timer, so re-issuing the token is
 * not optional here — without it the receiver's token expires within one TTL
 * and every one of its requests starts returning 401.
 */
function _adoptCastSession(session) {
  _muteSenderForCast();
  setupCastSync(session);
  void sendAuthToReceiver(session);
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

    // ORIGIN_SCOPED auto-join may have attached a session before our
    // SESSION_STATE_CHANGED listener existed, so no event will ever arrive for
    // it. Without this the sender keeps a session it never wired up: local audio
    // plays unmuted alongside the TV, seeks never reach the receiver
    // (_isCasting() needs remotePlayerController), and the receiver's token is
    // never refreshed.
    if (castSession) {
      castLog("OK", "adopting pre-existing Cast session");
      _adoptCastSession(castSession);
    }

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
        castLog("OK", "new Cast session started — handing over to receiver");
        beginCastHandover();
        setupCastSync(castSession);
        void sendAuthToReceiver(castSession);
        // Hand over from exactly where the user is now. Captured after the
        // pause above, so it cannot drift while the token mint and LOAD are in
        // flight — previously the sender played on for a second or two and was
        // then yanked backwards when the receiver finally reported in.
        void loadCurrentEpisodeOnCastSession(castSession, audioEl.currentTime || 0);
      }
      if (event.sessionState === cast.framework.SessionState.SESSION_RESUMED && castSession) {
        castLog("OK", "Cast session resumed — restoring sync");
        _adoptCastSession(castSession);
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
    script.src = "//www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
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
  // The receiver also asks for a token itself once its namespace listener is up
  // (the "ready" message), so this initial push is best-effort: if it lands
  // before the listener exists it is simply lost and the handshake covers us.
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
      // sendMessage returns a Promise — an unhandled rejection here is the
      // difference between "receiver has no token" and silence.
      await Promise.resolve(
        session.sendMessage(CAST_NAMESPACE, JSON.stringify({ type: "auth", token: data.token }))
      ).catch((err) => {
        castLog("ERROR", "sendMessage(auth) rejected:", (err && err.message) || err);
        throw err;
      });
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
        const hadToken = !!receiverAuthToken;
        receiverAuthToken = msg.token;
        if (hadToken) {
          // Routine refresh (or a duplicate from the ready handshake) — just
          // swap the token. Re-running the loads here would restart playback.
          castLog("OK", "auth token refreshed");
          return;
        }
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
    castLog("INFO", "LOAD interceptor fired - contentUrl:", (request.media && request.media.contentUrl) || "(none)");
    const customData = request.media && request.media.customData;
    if (!customData || !customData.episodeId) {
      castLog("WARN", "LOAD request had no customData.episodeId");
      return request;
    }
    castLog("INFO", "loading transcript for episode:", customData.episodeId);
    // Returning a Promise makes the framework hold playback until it settles.
    // Without this the audio started immediately while the transcript fetch was
    // still in flight, so the TV showed the PREVIOUS episode's transcript over
    // the new audio until the first words happened to land.
    //
    // Bounded by a race: a slow or failed transcript must never stop playback.
    const transcriptReady = loadEpisode(customData.episodeId, { skipAudioSrc: true })
      .catch((err) => { castLog("ERROR", "loadEpisode from LOAD interceptor failed:", err.message); });
    const deadline = new Promise((resolve) => setTimeout(resolve, RECEIVER_TRANSCRIPT_WAIT_MS));
    return Promise.race([transcriptReady, deadline]).then(() => request);
  });

  playerManager.addEventListener(cast.framework.events.EventType.ERROR, (event) => {
    const code = event.detailedErrorCode;
    const name = _castErrorName(code);
    const reason = event.reason || "";
    castLog("ERROR", `receiver playerManager error: ${code} (${name})`, reason);
  });

  // Receiver-side playback lifecycle. None of this was visible before, so a
  // stall, an unexpected buffer, or a silent end-of-media on the TV left no
  // trace at all in the logs.
  //
  // Subscribed through a guard because the available EventType constants vary
  // between Cast SDK versions: passing an undefined type would throw here and
  // take the whole receiver down for the sake of a log line.
  const onPlayerEvent = (typeName, handler) => {
    const type = cast.framework.events.EventType[typeName];
    if (!type) { castLog("WARN", "receiver: EventType not available:", typeName); return; }
    try {
      playerManager.addEventListener(type, handler);
    } catch (err) {
      castLog("WARN", `receiver: could not subscribe ${typeName}:`, err.message);
    }
  };

  onPlayerEvent("PLAYER_LOAD_COMPLETE", () =>
    castLog("OK", "receiver PLAYER_LOAD_COMPLETE — media ready"));
  onPlayerEvent("MEDIA_FINISHED", (event) =>
    castLog("INFO", "receiver MEDIA_FINISHED — reason:", (event && event.endedReason) || "?"));
  onPlayerEvent("BUFFERING", (event) =>
    castLog("INFO", "receiver BUFFERING:", event && event.isBuffering));
  onPlayerEvent("PLAYING", () =>
    castLog("INFO", "receiver PLAYING at", audioEl.currentTime.toFixed(2)));
  onPlayerEvent("PAUSE", () =>
    castLog("INFO", "receiver PAUSE at", audioEl.currentTime.toFixed(2)));
  onPlayerEvent("SEEKED", () =>
    castLog("INFO", "receiver SEEKED to", audioEl.currentTime.toFixed(2)));
  // High frequency — verbose only.
  onPlayerEvent("TIME_UPDATE", () =>
    castLogDebug("receiver TIME_UPDATE", audioEl.currentTime.toFixed(2)));

  // Start the receiver with our custom settings:
  // - disableIdleTimeout: prevent Chromecast from closing the app after inactivity
  // - touchScreenOptimizedApp: MUST stay false — see below
  // - autoResumeDuration: 0 means don't auto-resume from previous session
  castLog("INFO", "starting CastReceiverContext with namespace:", CAST_NAMESPACE);
  const options = new cast.framework.CastReceiverOptions();
  options.customNamespaces = {};
  options.customNamespaces[CAST_NAMESPACE] = cast.framework.system.MessageType.JSON;
  options.disableIdleTimeout = true;
  // false, deliberately. This flag ENABLES the framework's touch-optimised
  // media controls — it does not suppress them, which is what the old comment
  // here claimed. Setting it true is what put the Cast media banner on screen
  // every time playback paused. We render our own transcript UI, so the
  // framework must not draw controls over it.
  options.touchScreenOptimizedApp = false;
  options.playbackConfig = new cast.framework.PlaybackConfig();
  options.playbackConfig.autoResumeDuration = 0;
  context.start(options);
  castLog("OK", "CastReceiverContext started");

  // Transport interceptors. The framework drives audioEl directly via
  // setMediaElement, so these mostly observe — except for pinning the pause
  // position, which the framework does not preserve for us.
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.PAUSE, (requestData) => {
    // Remember exactly where the audio stopped. The framework's own clock keeps
    // advancing across a pause and it resumes from THAT, not from here — the
    // logs showed a pause at 39.16s resuming at 40.78s, so the transcript
    // restarted ~1.6s ahead of the audio. Captured here, restored on play.
    receiverPausedAtTime = audioEl.currentTime;
    castLog("INFO", "remote PAUSE command received — pinning", receiverPausedAtTime.toFixed(2));
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
    // A deliberate seek outranks the pinned pause position — drop the pin so
    // resume honours where the user actually asked to go.
    receiverPausedAtTime = null;
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
    // Ask the sender for an auth token now that our namespace listener exists.
    // Without this the token delivery depends on the sender's fixed 500ms delay
    // beating receiver startup — a race we lose on cold boots.
    _announceReceiverReady(event.senderId);
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
 * Tell the sender this receiver is listening on CAST_NAMESPACE and wants a token.
 * Sent on SENDER_CONNECTED, i.e. strictly after addCustomMessageListener ran.
 */
function _announceReceiverReady(senderId) {
  if (!receiverMode) return;
  try {
    const ctx = window.cast && window.cast.framework &&
      window.cast.framework.CastReceiverContext &&
      window.cast.framework.CastReceiverContext.getInstance();
    if (!ctx) return;
    ctx.sendCustomMessage(CAST_NAMESPACE, senderId, { type: "ready" });
    castLog("OK", "sent ready handshake to sender:", senderId || "(broadcast)");
  } catch (err) {
    castLog("WARN", "_announceReceiverReady failed:", err.message);
  }
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

/**
 * Render segment text as clickable, hoverable word spans.
 *
 * Two paths:
 *   1. Word-level timing available (Whisper JSON): render from currentWords
 *      with an index attribute for word-level highlighting during playback.
 *   2. Fallback (SRT or no timing): split on whitespace and render plain spans.
 *
 * The fullscreen/receiver view uses distinct attribute names so its highlight
 * selectors never collide with the sender view's.
 */
function appendWordSpans(container, text, segmentIndex, fs) {
  const indexKey = fs ? "fsWordIndex" : "wordIndex";
  const startAttr = fs ? "data-fs-start" : "data-start";
  const endAttr = fs ? "data-fs-end" : "data-end";
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
      wordEl.dataset[indexKey] = String(i);
      wordEl.setAttribute(startAttr, w.start);
      wordEl.setAttribute(endAttr, w.end);

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

function appendInteractiveText(container, text, segmentIndex = -1) {
  appendWordSpans(container, text, segmentIndex, false);
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
    // textContent, not innerHTML: ep.id/title come from filenames on disk, which
    // are never validated against the episode-id charset.
    btn.textContent = ep.title;
    const meta = document.createElement("span");
    meta.className = "picker-meta";
    meta.textContent = `${ep.id} · transcript: ${ep.transcript_type}`;
    btn.appendChild(meta);
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

/**
 * Build clickable segment rows into `container`.
 * `prefix` selects the sender ("segment") or fullscreen/receiver ("fs-segment")
 * class family; the two views are styled and highlighted independently.
 */
function renderSegmentRows(container, segments, prefix, fs) {
  container.innerHTML = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const row = document.createElement("div");
    row.className = prefix;
    row.dataset.index = String(i);

    const text = document.createElement("div");
    text.className = `${prefix}-text`;
    appendWordSpans(text, seg.text, i, fs);

    row.appendChild(text);
    appendSegmentCaption(row, seg.translation_en, `${prefix}-caption`);
    row.addEventListener("click", () => {
      _seekTo(seg.start);
    });

    container.appendChild(row);
  }
}

function renderSegments(segments) {
  if (!segments || segments.length === 0) {
    transcriptViewerEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No timestamped transcript found for this episode.";
    transcriptViewerEl.appendChild(empty);
    return;
  }
  renderSegmentRows(transcriptViewerEl, segments, "segment", false);
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

   // Remove previous active word highlight.
   const prevEls = transcriptViewerEl.querySelectorAll("[data-word-index].active, .translatable-word.active");
   for (const el of prevEls) {
     el.classList.remove("active");
   }

   // Set new active word
   activeWordIndex = nextIndex;
   if (activeWordIndex >= 0) {
     const activeEl = transcriptViewerEl.querySelector(`[data-word-index='${activeWordIndex}']`);
     if (activeEl) {
       activeEl.classList.add("active");
      activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
     }
   }
}

/**
 * Map each segment to its slice of the flat word array.
 *
 * The server stamps every word with `segment_index`. Older payloads lack it, so
 * we fall back to the original context-matching walk — which is why the stamp
 * exists: matching on text gave segment 0 every word of segment 1 whenever two
 * segments happened to share the same text.
 *
 * @returns {Array<{start: number, end: number}>} inclusive ranges; end < start means empty.
 */
function buildSegmentWordRanges(segments, words) {
  if (!segments.length || !words.length) return [];

  if (words[0].segment_index !== undefined) {
    const ranges = segments.map(() => ({ start: 0, end: -1 }));
    for (let wi = 0; wi < words.length; wi++) {
      const range = ranges[words[wi].segment_index];
      if (!range) continue;
      if (range.end < range.start) range.start = wi;
      range.end = wi;
    }
    return ranges;
  }

  const ranges = [];
  let wPtr = 0;
  for (let si = 0; si < segments.length; si++) {
    const segCtx = (segments[si].text || "").trim().toLowerCase();
    const startIdx = wPtr;
    while (wPtr < words.length) {
      if ((words[wPtr].context || "").trim().toLowerCase() !== segCtx) break;
      wPtr++;
    }
    ranges.push({ start: startIdx, end: wPtr - 1 });
  }
  return ranges;
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
  const loadStartedAt = Date.now();
  castLog("INFO", "loadEpisode:", id, "token:", loadToken,
    "skipCastLoad:", skipCastLoad, "skipAudioSrc:", skipAudioSrc,
    "casting:", _isCasting(), "from:", currentEpisodeId || "-");
  // Suspend reconciliation for the whole changeover, in BOTH directions. Until
  // the two ends agree on which media is loaded, their clocks describe
  // different timelines and comparing them corrupts whichever side is behind.
  if (_isCasting()) {
    if (skipCastLoad) {
      // The receiver switched first and already has the episode — we are only
      // catching up locally, so there is nothing to park.
      beginEpisodeTransition(`loading ${id}`, false);
    } else {
      // We are driving the change: park the sender until the receiver has the
      // new episode, or it plays the opening seconds alone and is then pulled
      // back when the receiver finally reports in.
      parkSenderForHandover(`loading ${id}`);
    }
  }
  currentEpisodeId = id;
  closeFsEpisodePicker();
  updateEpisodeListSelection();
  episodeTitleEl.textContent = `Loading ${id}...`;
  transcriptViewerEl.innerHTML = '<div class="empty">Loading transcript...</div>';

  try {
    const data = await fetchJson(`/api/episode/${encodeURIComponent(id)}`);
    castLog("INFO", `loadEpisode: transcript fetched in ${Date.now() - loadStartedAt}ms` +
      ` — type=${data.transcript_type} segments=${(data.segments || []).length}` +
      ` words=${(data.words || []).length}`);
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
    // The fullscreen pair MUST be reset too. These indices describe whichever
    // transcript is currently rendered, and we are about to replace it — the
    // receiver runs permanently in fullscreen, so a stale index here made
    // updateFsActiveSegment() short-circuit on `nextIndex === fsActiveSegmentIndex`
    // and leave the new episode unhighlighted until the index happened to move.
    fsActiveSegmentIndex = -1;
    fsActiveWordIndex = -1;
    // A pause pinned against the previous episode's timeline is meaningless now.
    receiverPausedAtTime = null;

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
        segmentWordRanges = buildSegmentWordRanges(currentSegments, currentWords);
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
  appendWordSpans(container, text, segmentIndex, true);
}

function renderFsSegments(segments) {
  renderSegmentRows(fsTranscriptEl, segments, "fs-segment", true);
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
  // Toggle local audio playback. While casting, the mirror on audioEl's own
  // play/pause events forwards this to the receiver — no explicit remote call
  // here, or the two would double-toggle and cancel out.
  castLog("INFO", "togglePlayPause — paused:", audioEl.paused,
    "src:", audioEl.src ? "set" : "empty", "readyState:", audioEl.readyState);

  // On the receiver, go through the PlayerManager rather than poking audioEl.
  // A raw audioEl.pause() stops the sound but does not always push a PAUSED
  // media status to senders, so the sender's remotePlayer.isPaused stays false.
  // Its 500ms drift interval then sees "remote playing, local paused",
  // restarts local playback, and half a second later snaps it back to the
  // receiver's frozen time — replaying the same ~1s of audio and transcript
  // forever. PlayerManager.play/pause broadcast the state change properly.
  if (receiverMode && receiverPlayerManager) {
    if (audioEl.paused) {
      receiverPlayerManager.play();
    } else {
      receiverPlayerManager.pause();
    }
    return;
  }

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
    const el = fsTranscriptEl.querySelector(`[data-fs-word-index='${activeWordIndex}']`);
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
  castLogDebug(`fs segment → ${fsActiveSegmentIndex} at ${t.toFixed(2)}s` +
    `${activeEl ? "" : " (NO DOM ELEMENT — transcript/index mismatch)"}`);
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
   fsTranscriptEl.querySelectorAll("[data-fs-word-index].active")
     .forEach(el => el.classList.remove("active"));

   fsActiveWordIndex = nextIndex;
   const activeEl = fsTranscriptEl.querySelector(`[data-fs-word-index='${fsActiveWordIndex}']`);
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

document.addEventListener("fullscreenchange", () => {
  if (isFullscreen) {
    fsOverlayEl.classList.remove("hidden");
  }
});

// ────────────────────────────────────────────────────────────────────────────

// ── Translation toggle ──────────────────────────────────────────────────────

function updateTranslationVisibility() {
  if (translationsVisible) {
    transcriptViewerEl.classList.remove("hide-translations");
    translationToggleBtnEl.classList.add("active");
  } else {
    transcriptViewerEl.classList.add("hide-translations");
    translationToggleBtnEl.classList.remove("active");
  }
}

translationToggleBtnEl.addEventListener("click", () => {
  translationsVisible = !translationsVisible;
  updateTranslationVisibility();
});

// ────────────────────────────────────────────────────────────────────────────

async function init() {
  castLog("INFO", "init() starting");
  try {
    if (receiverMode) {
      castLog("INFO", "entering receiver mode");
      enterFullscreen();

      // Set up Cast receiver for real Chromecast (auth token arrives via
      // namespace → loadEpisodesForReceiver).  In a regular browser the SDK
      // won't be found and initCastReceiver retries harmlessly.
      initCastReceiver();

      // Also try to load episodes immediately using cookie auth — this works
      // when testing in a browser.  On actual Chromecast (no cookies) this
      // will 401, which is fine; the Cast auth token flow handles it.
      if (!episodes.length) {
        castLog("INFO", "attempting eager episode load (cookie auth)");
        try {
          await loadRuntimeConfig();
          episodes = await fetchJson("/api/episodes");
          filteredEpisodes = episodes.slice();
          castLog("OK", "eager load succeeded:", episodes.length, "episodes");
          renderEpisodeList();
        } catch (err) {
          castLog("INFO", "eager load failed (expected on Chromecast):", err.message);
        }
      }

      if (!currentEpisodeId) {
        openFsEpisodePicker();
      }
      return;
    }

    // Sender mode: normal auth + data load flow.
    await ensureAuthenticatedSession();
    castLog("INFO", "auth session ensured");
    await loadRuntimeConfig();
    episodes = await fetchJson("/api/episodes");
    filteredEpisodes = episodes.slice();
    statusTextEl.textContent = `${episodes.length} episode(s) found.`;
    castLog("INFO", "episodes loaded:", episodes.length);
    renderEpisodeList();

    castLog("INFO", "entering sender mode");
    initCastSender();
  } catch (err) {
    castLog("ERROR", "init failed:", err.message);
    statusTextEl.textContent = `Error: ${err.message}`;
  }
}

audioEl.addEventListener("timeupdate", () => {
  updateActiveSegment();
  updateActiveWord();
  updateFsProgress();
  updateFsActiveSegment();
  updateFsActiveWord();
});
audioEl.addEventListener("seeked", () => {
  castLog("INFO", "audioEl seeked — time:", audioEl.currentTime.toFixed(2),
    "paused:", audioEl.paused, "casting:", _isCasting());
  if (isFullscreen) {
    fsTranscriptEl.querySelectorAll(".fs-segment.active").forEach(el => el.classList.remove("active"));
    fsTranscriptEl.querySelectorAll("[data-fs-word-index].active").forEach(el => el.classList.remove("active"));
  }
  transcriptViewerEl.querySelectorAll(".segment.active").forEach(el => el.classList.remove("active"));
  transcriptViewerEl.querySelectorAll("[data-word-index].active").forEach(el => el.classList.remove("active"));

  fsActiveSegmentIndex = -1;
  fsActiveWordIndex = -1;
  activeSegmentIndex = -1;
  activeWordIndex = -1;
  updateActiveSegment();
  updateActiveWord();
  updateFsActiveSegment();
  updateFsActiveWord();
});
/**
 * Should a resume be pulled back to where the receiver actually paused?
 *
 * Pure so it can be tested without a Cast SDK. Returns false when there is no
 * pin, when the gap is within tolerance (nothing to fix), or when the gap is
 * so large it must be a seek rather than framework clock drift.
 */
function shouldRestorePausePosition(pinnedTime, currentTime) {
  if (pinnedTime === null) return false;
  const gap = Math.abs(currentTime - pinnedTime);
  return gap > CAST_DRIFT_TOLERANCE_SEC && gap <= RECEIVER_RESUME_MAX_CORRECTION_SEC;
}

/**
 * On the receiver, snap playback back to the pinned pause position.
 *
 * The Cast framework resumes from its own clock, which keeps advancing while
 * paused, so a pause at 39.2s resumed at 40.8s — the transcript highlight ran
 * ~1.6s ahead of the audio until the audio caught up. The pin is consumed on
 * use, so this only ever corrects the first play after a pause.
 */
function restoreReceiverPausePosition() {
  if (!receiverMode) return;
  const pinned = receiverPausedAtTime;
  receiverPausedAtTime = null;
  if (!shouldRestorePausePosition(pinned, audioEl.currentTime)) return;
  castLog("INFO",
    `resume: restoring pinned position ${pinned.toFixed(2)} (was ${audioEl.currentTime.toFixed(2)})`);
  audioEl.currentTime = pinned;
}

audioEl.addEventListener("play", () => {
  castLog("INFO", "audioEl play - time:", audioEl.currentTime.toFixed(2),
    "muted:", audioEl.muted, "casting:", _isCasting());
  restoreReceiverPausePosition();
  mirrorLocalTransportToRemote();
  updateFsCaptionVisibility();
});
audioEl.addEventListener("pause", () => {
  castLog("INFO", "audioEl pause - time:", audioEl.currentTime.toFixed(2),
    "muted:", audioEl.muted, "casting:", _isCasting());
  mirrorLocalTransportToRemote();
  updateFsCaptionVisibility();
  ensureActiveSegmentTranslation();
});
audioEl.addEventListener("error", () => {
  const e = audioEl.error;
  castLog("ERROR", "audioEl error — code:", e ? e.code : "?", "message:", e ? e.message : "?",
    "src:", audioEl.src ? audioEl.src.substring(0, 80) : "empty");
});
audioEl.addEventListener("loadstart", () => {
  castLog("INFO", "audioEl loadstart — src:", audioEl.src ? audioEl.src.substring(0, 80) : "empty");
});
audioEl.addEventListener("canplay", () => {
  castLog("INFO", "audioEl canplay - duration:", audioEl.duration ? audioEl.duration.toFixed(1) : "?",
    "time:", audioEl.currentTime.toFixed(2));
  // When the RECEIVER initiated the episode change, the sender was the laggard
  // and the local element being ready is what we were waiting for. When WE sent
  // the LoadRequest, this fires long before the receiver has the new media, so
  // only loadMedia's own callback may end that transition.
  if (!castTransitionAwaitsLoadMedia) {
    endEpisodeTransition("local media ready");
  }
});
audioEl.addEventListener("waiting", () => {
  castLog("WARN", "audioEl waiting (buffering) — time:", audioEl.currentTime.toFixed(2));
});
audioEl.addEventListener("stalled", () => {
  castLog("WARN", "audioEl stalled — time:", audioEl.currentTime.toFixed(2),
    "networkState:", audioEl.networkState);
});

searchInputEl.addEventListener("input", applyFilter);
window.addEventListener("scroll", hideTooltip, true);

if (receiverEpisodesBtnEl) {
  receiverEpisodesBtnEl.addEventListener("click", () => {
    if (isFsEpisodePickerOpen) {
      if (currentEpisodeId) closeFsEpisodePicker();
    } else {
      openFsEpisodePicker();
    }
  });
}
if (fsEpisodePickerCloseBtnEl) {
  fsEpisodePickerCloseBtnEl.addEventListener("click", () => {
    if (currentEpisodeId) closeFsEpisodePicker();
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

/**
 * Spacebar play/pause on the normal (non-fullscreen) sender page.
 *
 * The main key handler below returns immediately unless isFullscreen, so
 * spacebar here relied entirely on the browser's default action for a focused
 * <audio> element. Whenever focus was anywhere else — which is most of the
 * time, and now that the page has a Logs link, easy to end up in — space did
 * its other default instead and scrolled the page.
 *
 * Routing through togglePlayPause() also means the receiver follows, via the
 * same transport mirror as the on-screen controls.
 */
document.addEventListener("keydown", (e) => {
  if (isFullscreen || receiverMode) return;
  if (e.key !== " " && e.code !== "Space") return;
  // Never steal the key from somewhere the user is typing, or from a control
  // whose own space behaviour is the point (buttons, checkboxes, links).
  const target = e.target;
  const tag = target && target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" ||
      tag === "A" || (target && target.isContentEditable)) {
    return;
  }
  e.preventDefault();   // stop the page scrolling
  castLog("INFO", "key: Space → togglePlayPause (sender)");
  togglePlayPause();
});

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

// Periodic state snapshot for both modes — see logSyncHeartbeat().
setInterval(logSyncHeartbeat, CAST_HEARTBEAT_MS);

// Kick off the application.
init();
