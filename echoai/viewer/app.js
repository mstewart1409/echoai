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
const urlParams = new URLSearchParams(window.location.search);
const receiverMode = urlParams.get("mode") === "receiver" || urlParams.get("receiver") === "1";
const castDebugEnabled = urlParams.get("castDebug") === "1;

// ── Cast Debug Logger ────────────────────────────────────────────────────────
const CAST_LOG_MAX = 200;
const castLogEntries = [];
let castDebugPanelEl = null;
let castDebugPanelBodyEl = null;

let castDebugFullscreen = false;

function _ensureCastDebugPanel() {
  if (castDebugPanelEl) return;
  castDebugPanelEl = document.createElement("div");
  castDebugPanelEl.id = "castDebugPanel";
  castDebugPanelEl.className = "cast-debug-panel";
  const header = document.createElement("div");
  header.className = "cast-debug-header";
  header.innerHTML =
    '<span style="font-weight:bold;color:#0f0">🔊 Cast Debug</span>';
  const btnGroup = document.createElement("span");

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy";
  copyBtn.tabIndex = -1;
  copyBtn.className = "cast-debug-btn";
  copyBtn.addEventListener("click", () => {
    const text = castLogEntries.map((e) => `[${e.ts}] ${e.level} ${e.msg}`).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  });

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear";
  clearBtn.tabIndex = -1;
  clearBtn.className = "cast-debug-btn";
  clearBtn.addEventListener("click", () => {
    castLogEntries.length = 0;
    if (castDebugPanelBodyEl) castDebugPanelBodyEl.innerHTML = "";
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.tabIndex = -1;
  closeBtn.className = "cast-debug-btn cast-debug-close-btn";
  closeBtn.addEventListener("click", () => {
    hideCastDebugPanel();
  });

  btnGroup.appendChild(copyBtn);
  btnGroup.appendChild(clearBtn);
  btnGroup.appendChild(closeBtn);
  header.appendChild(btnGroup);
  castDebugPanelEl.appendChild(header);

  castDebugPanelBodyEl = document.createElement("div");
  castDebugPanelBodyEl.className = "cast-debug-body";
  castDebugPanelEl.appendChild(castDebugPanelBodyEl);
  document.body.appendChild(castDebugPanelEl);
}

function showCastDebugPanel() {
  _ensureCastDebugPanel();
  castDebugFullscreen = true;
  castDebugPanelEl.classList.add("fullscreen");
  castDebugPanelEl.style.display = "";
  // Back-fill existing log entries into the panel body.
  if (castDebugPanelBodyEl && castDebugPanelBodyEl.children.length === 0) {
    for (const entry of castLogEntries) {
      const line = document.createElement("div");
      const color = entry.level === "ERROR" ? "#f44" : entry.level === "WARN" ? "#fa0" : entry.level === "OK" ? "#4f4" : "#0f0";
      line.style.cssText = `color:${color};word-break:break-all;border-bottom:1px solid #111;padding:1px 0;`;
      line.textContent = `${entry.ts} ${entry.level} ${entry.msg}`;
      castDebugPanelBodyEl.appendChild(line);
    }
  }
  castDebugPanelEl.scrollTop = castDebugPanelEl.scrollHeight;
  castLog("INFO", "debug panel opened (fullscreen)");
}

function hideCastDebugPanel() {
  if (!castDebugPanelEl) return;
  castDebugFullscreen = false;
  castDebugPanelEl.classList.remove("fullscreen");
  castDebugPanelEl.style.display = "none";
  castLog("INFO", "debug panel closed");
}

function toggleCastDebugPanel() {
  _ensureCastDebugPanel();
  if (castDebugFullscreen) {
    hideCastDebugPanel();
  } else {
    showCastDebugPanel();
  }
}

function castLog(level, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  const tag = `[Cast/${level}]`;

  if (level === "ERROR") {
    console.error(tag, ...args);
  } else if (level === "WARN") {
    console.warn(tag, ...args);
  } else {
    console.log(tag, ...args);
  }

  castLogEntries.push({ ts, level, msg });
  if (castLogEntries.length > CAST_LOG_MAX) castLogEntries.shift();

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
// ─────────────────────────────────────────────────────────────────────────────

let episodes = [];
let filteredEpisodes = [];
let currentEpisodeId = null;
let currentSegments = [];
let currentWords = [];
let segmentWordRanges = [];  // [{start: globalWordIdx, end: globalWordIdx}] per segment
let activeSegmentIndex = -1;
let activeWordIndex = -1;
let translationsVisible = true;

let isFullscreen = false;
let fsActiveSegmentIndex = -1;
let fsActiveWordIndex = -1;
const translationCache = new Map();
const segmentTranslationCache = new Map();
let hoverTimer = null;
let hideTimer = null;
let activeEpisodeLoadToken = 0;
let isFsEpisodePickerOpen = false;
let fsEpisodePickerIndex = -1;
let castSession = null;
let isCastReady = false;
let runtimeConfig = {};
const CAST_NAMESPACE = "urn:x-cast:com.echoai.auth";
let receiverAuthToken = null;
let receiverPlayerManager = null;

// ── Bidirectional Cast sync state ────────────────────────────────────────────
let remotePlayer = null;
let remotePlayerController = null;
let castTimeSyncInterval = null;
let castTokenRefreshInterval = null;

/**
 * Whether we have an active Cast session.  Uses `castSession` (set reliably
 * by SESSION_STATE_CHANGED) rather than `remotePlayer.isConnected` which can
 * lag behind or require media to be loaded first.
 */
function _isCasting() {
  return !!(castSession && remotePlayerController);
}

/**
 * Seek to a time.  When casting, seek both the local (muted) audioEl — which
 * drives transcript tracking via its native timeupdate — and the Chromecast.
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
 * shows the correct time position.  Safe to call repeatedly — no-ops if
 * already playing.  Handles promise rejection gracefully.
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
  const fromQuery = new URLSearchParams(window.location.search).get("receiverAppId");
  if (fromQuery) { castLog("INFO", "appId from query:", fromQuery); return fromQuery; }
  const fromStorage = localStorage.getItem("castReceiverAppId");
  if (fromStorage) { castLog("INFO", "appId from localStorage:", fromStorage); return fromStorage; }
  if (runtimeConfig.cast_receiver_app_id) { castLog("INFO", "appId from config:", runtimeConfig.cast_receiver_app_id); return runtimeConfig.cast_receiver_app_id; }
  castLog("WARN", "using default Cast appId CC1AD845");
  return "CC1AD845"; // Default Media Receiver fallback
}

async function ensureAuthenticatedSession() {
  // In receiver mode, try token from query string first (passed by sender).
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
      // Skip re-loading if we already have this episode's transcript loaded
      // (e.g. receiverEstablishMediaSession triggers LOAD after local loadEpisode).
      if (customData.episodeId === currentEpisodeId && currentSegments.length > 0) {
        castLog("INFO", "LOAD interceptor: episode already loaded, skipping transcript reload");
      } else {
        castLog("INFO", "loading transcript for episode:", customData.episodeId);
        loadEpisode(customData.episodeId, { skipAudioSrc: true })
          .catch((err) => { castLog("ERROR", "loadEpisode from LOAD interceptor failed:", err.message); });
      }
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

  // Start the receiver with the custom namespace registered.
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
 * Establish a Cast media session on the receiver so the sender's RemotePlayer
 * tracks the media (play/pause, seek, duration).  Called when the receiver's
 * own UI selects an episode — bypasses the sender's LOAD flow.
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
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  tooltipEl.classList.add("hidden");
}

function showTooltip(text, x, y, showExplain = false) {
  tooltipTextEl.textContent = text;
  tooltipEl.style.left = `${x + 12}px`;
  tooltipEl.style.top = `${y + 12}px`;
  tooltipExplainBtnEl.style.display = showExplain ? "inline-block" : "none";
  tooltipEl.classList.remove("hidden");
}

function hideTooltipSoon(delay = 180) {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hideTooltip(), delay);
}

tooltipEl.addEventListener("mouseenter", () => {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
});

tooltipEl.addEventListener("mouseleave", () => hideTooltipSoon(120));

tooltipExplainBtnEl.addEventListener("click", async () => {
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
  const captionEl = document.createElement("div");
  captionEl.className = className;
  setCaptionText(captionEl, translation);
  container.appendChild(captionEl);
  return captionEl;
}

function setCaptionText(captionEl, translation) {
  const text = (translation || "").trim();
  captionEl.textContent = text;
  captionEl.hidden = !text;
}

function ensureCaptionElement(rowEl, className) {
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
  if (activeSegmentIndex < 0) return;
  void lazyTranslateAround(activeSegmentIndex, activeEpisodeLoadToken);
}

async function hydrateSegmentTranslations(loadToken) {
  // Lazy: only translate the active segment and a few neighbours.
  // Called from ensureActiveSegmentTranslation on each timeupdate.
  void lazyTranslateAround(activeSegmentIndex, loadToken);
}

let _translatingAroundCenter = -1;

async function lazyTranslateAround(center, loadToken) {
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
      await loadEpisode(ep.id);
      if (receiverMode) {
        receiverEstablishMediaSession(ep.id);
        notifySenderEpisodeChanged(ep.id);
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
  await loadEpisode(ep.id);
  if (receiverMode) {
    receiverEstablishMediaSession(ep.id);
    notifySenderEpisodeChanged(ep.id);
  }
}

function renderSegments(segments) {
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
  if (!currentSegments.length) return;
  const t = audioEl.currentTime + 0.05;
  let nextIdx = currentSegments.findIndex((seg) => seg.start > t);
  if (nextIdx < 0) nextIdx = currentSegments.length - 1;
  castLog("INFO", "jumpToNextSegment → index:", nextIdx, "from:", t.toFixed(1));
  seekToSegment(nextIdx);
}

function jumpToPreviousSegment() {
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

// Progress bar scrubbing
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
    fsTranscriptEl.querySelectorAll("[data-fs-word-index].active, .fs-word.active").forEach(el => el.classList.remove("active"));
  }
  transcriptViewerEl.querySelectorAll(".segment.active").forEach(el => el.classList.remove("active"));
  transcriptViewerEl.querySelectorAll("[data-word-index].active, .word.active").forEach(el => el.classList.remove("active"));

  fsActiveSegmentIndex = -1;
  fsActiveWordIndex = -1;
  activeSegmentIndex = -1;
  activeWordIndex = -1;
  updateActiveSegment();
  updateActiveWord();
  updateFsActiveSegment();
  updateFsActiveWord();
});
audioEl.addEventListener("play", () => {
  castLog("INFO", "audioEl play — time:", audioEl.currentTime.toFixed(2),
    "muted:", audioEl.muted, "casting:", _isCasting());
  updateFsCaptionVisibility();
});
audioEl.addEventListener("pause", () => {
  castLog("INFO", "audioEl pause — time:", audioEl.currentTime.toFixed(2),
    "muted:", audioEl.muted, "casting:", _isCasting());
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
  castLog("INFO", "audioEl canplay — duration:", audioEl.duration ? audioEl.duration.toFixed(1) : "?",
    "time:", audioEl.currentTime.toFixed(2));
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

init();
