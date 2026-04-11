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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function getCastReceiverAppId() {
  const fromQuery = new URLSearchParams(window.location.search).get("receiverAppId");
  if (fromQuery) return fromQuery;
  const fromStorage = localStorage.getItem("castReceiverAppId");
  if (fromStorage) return fromStorage;
  if (runtimeConfig.cast_receiver_app_id) return runtimeConfig.cast_receiver_app_id;
  return "CC1AD845"; // Default Media Receiver fallback
}

async function ensureAuthenticatedSession() {
  const statusRes = await fetch("/api/auth/status");
  if (!statusRes.ok) {
    throw new Error(`Auth status failed: ${statusRes.status}`);
  }

  const status = await statusRes.json();
  if (status.authenticated) {
    return;
  }

  const username = globalThis.prompt("Username", status.username_hint || "") || "";
  const password = globalThis.prompt("Password", "") || "";
  if (!username || !password) {
    throw new Error("Login canceled.");
  }

  const loginRes = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status}`);
  }
}

async function requestCastSessionToken(episodeId) {
  const response = await fetch("/api/cast/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episode_id: episodeId }),
  });

  if (!response.ok) {
    throw new Error(`Cast token request failed: ${response.status}`);
  }
  const data = await response.json();
  return data.token || null;
}

async function loadRuntimeConfig() {
  try {
    runtimeConfig = await fetchJson('/api/config');
  } catch {
    runtimeConfig = {};
  }
}

function updateCastButtonState() {
  if (!castBtnEl) return;
  if (!isCastReady) {
    castBtnEl.classList.add("hidden");
    return;
  }

  const connected = !!castSession;
  castBtnEl.classList.remove("hidden");
  castBtnEl.classList.toggle("connected", connected);
  castBtnEl.textContent = connected ? "Casting" : "Cast";
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

async function loadCurrentEpisodeOnCastSession(session) {
  const meta = getCurrentEpisodeMeta();
  if (!meta) return;

  let mediaUrl = meta.mediaUrl;
  try {
    const token = await requestCastSessionToken(meta.id);
    if (token) {
      mediaUrl = `${meta.mediaUrl}${meta.mediaUrl.includes("?") ? "&" : "?"}rt=${encodeURIComponent(token)}`;
    }
  } catch (err) {
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
    startTime: audioEl.currentTime || 0,
  };

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.currentTime = audioEl.currentTime || 0;
  request.autoplay = true;

  session.loadMedia(request, () => {}, () => {});
}

function initCastSender() {
  if (!castBtnEl) return;

  window.__onGCastApiAvailable = function (isAvailable) {
    if (!isAvailable || !window.cast || !window.cast.framework) {
      return;
    }

    const context = cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: getCastReceiverAppId(),
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });

    isCastReady = true;
    castSession = context.getCurrentSession() || null;
    updateCastButtonState();

    context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
      const activeStates = [
        cast.framework.SessionState.SESSION_STARTING,
        cast.framework.SessionState.SESSION_STARTED,
        cast.framework.SessionState.SESSION_RESUMED,
      ];

      castSession = activeStates.includes(event.sessionState)
        ? context.getCurrentSession()
        : null;

      updateCastButtonState();

      if (event.sessionState === cast.framework.SessionState.SESSION_STARTED && castSession) {
        void loadCurrentEpisodeOnCastSession(castSession);
      }
    });
  };

  const script = document.createElement("script");
  script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
  script.async = true;
  document.head.appendChild(script);

  castBtnEl.addEventListener("click", async () => {
    if (!isCastReady || !window.cast || !window.cast.framework) return;

    const context = cast.framework.CastContext.getInstance();
    const existing = context.getCurrentSession();
    if (existing) {
      existing.endSession(true);
      castSession = null;
      updateCastButtonState();
      return;
    }

    try {
      await context.requestSession();
      castSession = context.getCurrentSession();
      updateCastButtonState();
      if (castSession) {
        void loadCurrentEpisodeOnCastSession(castSession);
      }
    } catch {
      // User canceled cast dialog or cast failed to start.
    }
  });
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
  } catch {
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
  const data = await fetchJson(`/api/translate?${params}`);
  const result = { display: data.display || "", translation: (data.translation || "").trim() };
  translationCache.set(cacheKey, result);
  return result;
}

async function translateSegmentText(text) {
  const clean = (text || "").trim();
  if (!clean) return "";
  if (segmentTranslationCache.has(clean)) return segmentTranslationCache.get(clean);

  const params = new URLSearchParams({ text: clean });
  const data = await fetchJson(`/api/translate-text?${params}`);
  const translation = (data.translation || "").trim();
  segmentTranslationCache.set(clean, translation);
  return translation;
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
      } catch {
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
        audioEl.currentTime = w.start;
        if (audioEl.paused) audioEl.play();
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
  } catch {
    // Keep transcript usable even if translation loading fails.
  }
}

function ensureActiveSegmentTranslation() {
  if (activeSegmentIndex < 0) return;
  void loadSegmentTranslation(activeSegmentIndex, activeEpisodeLoadToken);
}

async function hydrateSegmentTranslations(loadToken) {
  if (loadToken !== activeEpisodeLoadToken || !currentSegments.length) return;

  const indices = [...currentSegments.keys()];
  if (activeSegmentIndex > 0) {
    indices.splice(activeSegmentIndex, 1);
    indices.unshift(activeSegmentIndex);
  }

  for (const index of indices) {
    if (loadToken !== activeEpisodeLoadToken) return;
    await loadSegmentTranslation(index, loadToken);
  }
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
    item.addEventListener("click", () => loadEpisode(ep.id));
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

  const selectedIdx = episodes.findIndex((ep) => ep.id === currentEpisodeId);
  fsEpisodePickerIndex = selectedIdx >= 0 ? selectedIdx : 0;
  isFsEpisodePickerOpen = true;
  fsEpisodePickerEl.classList.remove("hidden");
  renderFsEpisodePicker();
}

function closeFsEpisodePicker() {
  if (!fsEpisodePickerEl) return;
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
  closeFsEpisodePicker();
  await loadEpisode(ep.id);
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
      audioEl.currentTime = seg.start;
      if (audioEl.paused) audioEl.play();
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
        audioEl.currentTime = rowStart;
        if (audioEl.paused) audioEl.play();
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
      audioEl.currentTime = word.start;
      if (audioEl.paused) audioEl.play();
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

async function loadEpisode(id) {
  const loadToken = ++activeEpisodeLoadToken;
  currentEpisodeId = id;
  closeFsEpisodePicker();
  updateEpisodeListSelection();
  episodeTitleEl.textContent = `Loading ${id}...`;
  transcriptViewerEl.innerHTML = '<div class="empty">Loading transcript...</div>';

  try {
    const data = await fetchJson(`/api/episode/${encodeURIComponent(id)}`);
    if (loadToken !== activeEpisodeLoadToken) return;

    currentEpisodeId = data.id;
    currentSegments = [];
    currentWords = [];
    segmentWordRanges = [];
    activeSegmentIndex = -1;
    activeWordIndex = -1;

    episodeTitleEl.textContent = data.title;
    audioEl.src = data.audio;

    if (castSession) {
      loadCurrentEpisodeOnCastSession(castSession);
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
    } else if (data.transcript_type === "txt") {
      syncHintEl.textContent = "Plain text transcript (no timestamps available).";
      renderPlainText(data.text || "");
      if (isFullscreen) {
        fsTranscriptEl.innerHTML = '<div class="fs-empty">No timestamped transcript available.</div>';
      }
    } else {
      syncHintEl.textContent = "No transcript yet. Generate with transcribe_podcasts.py.";
      renderPlainText("");
      if (isFullscreen) {
        fsTranscriptEl.innerHTML = '<div class="fs-empty">No transcript available.</div>';
      }
    }

    updateEpisodeListSelection();
    renderFsEpisodePicker();
  } catch (err) {
    if (loadToken !== activeEpisodeLoadToken) return;
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
        audioEl.currentTime = w.start;
        if (audioEl.paused) audioEl.play();
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
      audioEl.currentTime = seg.start;
      if (audioEl.paused) audioEl.play();
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
        audioEl.currentTime = rowStart;
        if (audioEl.paused) audioEl.play();
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
      audioEl.currentTime = word.start;
      if (audioEl.paused) audioEl.play();
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
  audioEl.currentTime = seg.start;
  if (audioEl.paused) audioEl.play();
}

function jumpToNextSegment() {
  if (!currentSegments.length) return;
  const t = audioEl.currentTime + 0.05;
  let nextIdx = currentSegments.findIndex((seg) => seg.start > t);
  if (nextIdx < 0) nextIdx = currentSegments.length - 1;
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
  seekToSegment(prevIdx);
}

function togglePlayPause() {
  if (audioEl.paused) {
    audioEl.play();
  } else {
    audioEl.pause();
  }
}

function enterFullscreen() {
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
  audioEl.currentTime = ((e.clientX - rect.left) / rect.width) * audioEl.duration;
});

if (fsExitBtnEl) fsExitBtnEl.addEventListener("click", exitFullscreen);
if (fullscreenBtnEl) fullscreenBtnEl.addEventListener("click", enterFullscreen);

if (receiverPrevBtnEl) receiverPrevBtnEl.addEventListener("click", jumpToPreviousSegment);
if (receiverNextBtnEl) receiverNextBtnEl.addEventListener("click", jumpToNextSegment);
if (receiverToggleBtnEl) receiverToggleBtnEl.addEventListener("click", togglePlayPause);

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
  try {
    await ensureAuthenticatedSession();
    await loadRuntimeConfig();
    episodes = await fetchJson("/api/episodes");
    filteredEpisodes = episodes.slice();
    statusTextEl.textContent = `${episodes.length} episode(s) found.`;
    renderEpisodeList();

    if (receiverMode) {
      enterFullscreen();
      if (!currentEpisodeId) {
        openFsEpisodePicker();
      }
    } else {
      initCastSender();
    }
  } catch (err) {
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
audioEl.addEventListener("play", updateFsCaptionVisibility);
audioEl.addEventListener("pause", () => {
  updateFsCaptionVisibility();
  ensureActiveSegmentTranslation();
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

// Chromecast remote behavior:
// - Episode picker open: up/down to move, enter/space to select.
// - Episode picker closed: left/right for segment nav, enter/space play/pause.
document.addEventListener("keydown", async (e) => {
  if (!isFullscreen) return;

  if (isFsEpisodePickerOpen) {
    if (e.code === "ArrowUp") {
      e.preventDefault();
      moveFsEpisodePicker(-1);
      return;
    }
    if (e.code === "ArrowDown") {
      e.preventDefault();
      moveFsEpisodePicker(1);
      return;
    }
    if (e.code === "Enter" || e.code === "Space") {
      e.preventDefault();
      await selectEpisodeFromFsPicker();
      return;
    }
    if (e.code === "Escape") {
      e.preventDefault();
      if (currentEpisodeId) closeFsEpisodePicker();
      return;
    }
    return;
  }

  if (e.code === "ArrowLeft") {
    e.preventDefault();
    jumpToPreviousSegment();
    return;
  }
  if (e.code === "ArrowRight") {
    e.preventDefault();
    jumpToNextSegment();
    return;
  }
  if (e.code === "Enter" || e.code === "Space") {
    e.preventDefault();
    togglePlayPause();
    return;
  }
  if (e.code === "ArrowUp") {
    e.preventDefault();
    openFsEpisodePicker();
  }
});

init();

