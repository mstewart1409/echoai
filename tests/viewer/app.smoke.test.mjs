// Tier-1 smoke test for echoai/viewer/app.js.
//
// Executes the real app.js against a stub DOM and asserts the bootstrap runs
// and the event wiring exists. This exists because commit 155f959 silently
// deleted init() and every audio listener, leaving the viewer dead on load with
// nothing in CI to notice.
//
// Run: node --test tests/viewer/
// Also run automatically by tests/test_viewer_smoke.py (skipped if node absent).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

function assertSameShape(actual, expected, msg) {
  // vm objects have a different Object prototype, so deepStrictEqual always fails.
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(HERE, '..', '..', 'echoai', 'viewer', 'app.js');

/** Auto-vivifying stub element: any property access yields something usable. */
function makeElement(name, log) {
  const target = {
    _name: name,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    value: '',
    muted: false,
    paused: true,
    currentTime: 0,
    duration: 0,
    src: '',
    tabIndex: 0,
    addEventListener(type) {
      log.push(`${name}:${type}`);
    },
    removeEventListener() {},
    appendChild: (c) => c,
    removeChild: (c) => c,
    querySelectorAll: () => [],
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 10 }),
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    scrollIntoView() {},
    play: () => Promise.resolve(),
    pause() {},
    load() {},
    insertBefore: (c) => c,
    contains: () => false,
    closest: () => null,
    remove() {},
    children: [],
    parentNode: null,
    firstChild: null,
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => undefined; // unknown method -> harmless no-op
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  });
}

/** Load app.js in a sandbox. Returns recorded listeners and any load error. */
async function loadApp(search = '') {
  const listeners = [];
  const fetchCalls = [];
  // Memoized so a test can grab the very element app.js captured (audioEl is a
  // top-level const — the only way to influence it is to mutate that object).
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id, listeners));
    return elements.get(id);
  };

  const document = {
    getElementById: getElement,
    createElement: (tag) => makeElement(`<${tag}>`, listeners),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (type) => listeners.push(`document:${type}`),
    removeEventListener() {},
    body: makeElement('body', listeners),
    head: makeElement('head', listeners),
    activeElement: null,
    fullscreenElement: null,
    exitFullscreen: () => Promise.resolve(),
    hidden: false,
  };

  const windowStub = {
    location: { search, origin: 'http://localhost:5000', href: 'http://localhost:5000/' + search },
    addEventListener: (type) => listeners.push(`window:${type}`),
    removeEventListener() {},
    cast: undefined,
    chrome: undefined,
  };

  // Non-scheduling timers: initCastReceiver() re-arms itself every 200ms while
  // the Cast SDK is absent, and setupCastSync() installs a 500ms interval.
  // Real timers would keep the event loop alive forever.
  let timerId = 0;
  const sandbox = {
    window: windowStub,
    document,
    navigator: { userAgent: 'node-smoke-test', clipboard: { writeText: () => Promise.resolve() } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URLSearchParams,
    URL,
    console,
    setTimeout: () => ++timerId,
    clearTimeout: () => {},
    setInterval: () => ++timerId,
    clearInterval: () => {},
    Promise,
    JSON,
    Math,
    Date,
    globalThis: undefined, // set below
    fetch: (url) => {
      fetchCalls.push(String(url));
      // Reject so init()'s error path runs without needing a server.
      return Promise.reject(new Error('offline smoke test'));
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  const code = fs.readFileSync(APP_JS, 'utf8');

  let error = null;
  try {
    new vm.Script(code, { filename: 'app.js' }).runInContext(context);
  } catch (err) {
    error = err;
  }
  // init() is async — let its first awaits settle before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // `function` declarations land on the sandbox global, but top-level `let`
  // bindings do not — mutating those needs code evaluated inside the context.
  const evalIn = (src) => vm.runInContext(src, context);
  return { listeners, fetchCalls, error, sandbox, evalIn, getElement };
}

test('app.js parses and executes without a ReferenceError', async () => {
  const { error } = await loadApp();
  assert.equal(error, null, `app.js threw on load: ${error && error.stack}`);
});

test('bootstrap runs: init() is defined and invoked', async () => {
  const { sandbox, fetchCalls, error } = await loadApp();
  assert.equal(error, null);
  assert.equal(typeof sandbox.init, 'function', 'init() must be defined');
  // init() in sender mode immediately hits /api/auth/status.
  assert.ok(
    fetchCalls.some((u) => u.includes('/api/auth/status')),
    `init() never ran — no auth call. fetches: ${JSON.stringify(fetchCalls)}`
  );
});

test('cast entry points are defined', async () => {
  const { sandbox } = await loadApp();
  for (const fn of ['initCastSender', 'initCastReceiver', 'sendAuthToReceiver', 'setupCastSync']) {
    assert.equal(typeof sandbox[fn], 'function', `${fn}() must be defined`);
  }
});

test('audio element event wiring is present', async () => {
  const { listeners } = await loadApp();
  // timeupdate drives all transcript highlighting; without it the app is inert.
  for (const type of ['timeupdate', 'seeked', 'play', 'pause', 'error']) {
    assert.ok(
      listeners.includes(`audioPlayer:${type}`),
      `missing audioPlayer "${type}" listener. got: ${JSON.stringify(listeners)}`
    );
  }
});

test('UI event wiring is present', async () => {
  const { listeners } = await loadApp();
  assert.ok(listeners.includes('searchInput:input'), 'missing search input listener');
  assert.ok(listeners.includes('document:keydown'), 'missing keydown listener');
  assert.ok(listeners.includes('document:keyup'), 'missing keyup listener');
});

test('receiver mode boots without error', async () => {
  const { error, sandbox } = await loadApp('?mode=receiver');
  assert.equal(error, null, `receiver mode threw: ${error && error.stack}`);
  assert.equal(typeof sandbox.init, 'function');
});

test('sender and receiver renderers emit their own class families', async () => {
  // renderSegments and renderFsSegments share one implementation. If the shared
  // renderer ever leaks the wrong prefix, the fullscreen/receiver transcript on
  // the TV silently loses all its styling and highlight selectors.
  const { sandbox, error } = await loadApp();
  assert.equal(error, null);

  const created = [];
  const attrs = [];
  sandbox.document.createElement = (tag) => {
    const el = makeElement(`<${tag}>`, []);
    created.push(el);
    el.setAttribute = (k, v) => attrs.push(`${k}=${v}`);
    return el;
  };

  const segments = [{ start: 0, end: 1, text: 'Hallo Welt', translation_en: 'Hello world' }];

  created.length = 0;
  sandbox.renderSegments(segments);
  const senderClasses = created.map((e) => e.className);
  assert.ok(senderClasses.includes('segment'), `expected .segment, got ${senderClasses}`);
  assert.ok(senderClasses.includes('segment-text'), `expected .segment-text, got ${senderClasses}`);
  assert.ok(!senderClasses.some((c) => String(c).startsWith('fs-')), 'sender leaked fs- classes');

  created.length = 0;
  sandbox.renderFsSegments(segments);
  const fsClasses = created.map((e) => e.className);
  assert.ok(fsClasses.includes('fs-segment'), `expected .fs-segment, got ${fsClasses}`);
  assert.ok(fsClasses.includes('fs-segment-text'), `expected .fs-segment-text, got ${fsClasses}`);
});

test('word spans use distinct index attributes per view', async () => {
  // The two views must never share an index attribute, or their highlight
  // selectors collide and the receiver fights the sender for .active.
  const { sandbox, evalIn, error } = await loadApp();
  assert.equal(error, null);

  evalIn(`
    currentWords = [{ word: 'Hallo', start: 0, end: 0.5, probability: 0.9 }];
    segmentWordRanges = [{ start: 0, end: 0 }];
  `);

  function capture(fnName) {
    const keys = [];
    const attrs = [];
    const container = makeElement('container', []);
    container.childNodes = [];
    sandbox.document.createElement = () => {
      const el = makeElement('span', []);
      el.dataset = new Proxy({}, { set: (t, k, v) => (keys.push(k), (t[k] = v), true) });
      el.setAttribute = (k) => attrs.push(k);
      return el;
    };
    sandbox.document.createTextNode = () => ({});
    sandbox[fnName](container, 'Hallo', 0);
    return { keys, attrs };
  }

  const sender = capture('appendInteractiveText');
  const fs = capture('appendFsInteractiveText');

  assert.ok(sender.keys.includes('wordIndex'), `sender keys: ${sender.keys}`);
  assert.ok(sender.attrs.includes('data-start'), `sender attrs: ${sender.attrs}`);
  assert.ok(fs.keys.includes('fsWordIndex'), `fs keys: ${fs.keys}`);
  assert.ok(fs.attrs.includes('data-fs-start'), `fs attrs: ${fs.attrs}`);
  assert.ok(!fs.keys.includes('wordIndex'), 'fs view leaked the sender index key');
});

test('buildSegmentWordRanges maps words by segment_index', async () => {
  // Two segments with identical text must still own their own words. Matching on
  // text gave segment 0 every word of segment 1.
  const { sandbox, error } = await loadApp();
  assert.equal(error, null);

  const segments = [{ text: 'Ja genau.' }, { text: 'Ja genau.' }];
  const words = [
    { word: 'Ja', segment_index: 0, context: 'Ja genau.' },
    { word: 'genau', segment_index: 1, context: 'Ja genau.' },
  ];
  assertSameShape(sandbox.buildSegmentWordRanges(segments, words), [
    { start: 0, end: 0 },
    { start: 1, end: 1 },
  ]);
});

test('buildSegmentWordRanges falls back to context matching without segment_index', async () => {
  const { sandbox } = await loadApp();
  const segments = [{ text: 'Eins' }, { text: 'Zwei' }];
  const words = [
    { word: 'Eins', context: 'Eins' },
    { word: 'Zwei', context: 'Zwei' },
  ];
  assertSameShape(sandbox.buildSegmentWordRanges(segments, words), [
    { start: 0, end: 0 },
    { start: 1, end: 1 },
  ]);
});

test('buildSegmentWordRanges tolerates empty input and out-of-range indices', async () => {
  const { sandbox } = await loadApp();
  assertSameShape(sandbox.buildSegmentWordRanges([], []), []);
  assertSameShape(sandbox.buildSegmentWordRanges([{ text: 'a' }], []), []);
  // A word pointing past the end of the segment list must be ignored, not throw.
  const ranges = sandbox.buildSegmentWordRanges([{ text: 'a' }], [{ segment_index: 9 }]);
  assertSameShape(ranges, [{ start: 0, end: -1 }]);
});

test('castShouldSnap corrects the pause overshoot regardless of play state', async () => {
  // On pause the local muted audioEl keeps running for the Cast round-trip and
  // halts ~1-2s ahead of the receiver. The old code only snapped when paused if
  // drift > 2s, so that overshoot survived until resume and the transcript
  // highlight started ~2s ahead of the audio. One threshold, always applied.
  const { sandbox, error } = await loadApp();
  assert.equal(error, null);

  assert.equal(sandbox.castShouldSnap(100, 100), false, 'identical times must not snap');
  assert.equal(sandbox.castShouldSnap(100.3, 100), false, 'sub-tolerance drift must not snap');
  // The regression: a 1.5s pause overshoot must be corrected, not ignored.
  assert.equal(sandbox.castShouldSnap(101.5, 100), true, 'pause overshoot must snap');
  assert.equal(sandbox.castShouldSnap(100, 101.5), true, 'drift is symmetric');
});

// ── Cast reconciler ──────────────────────────────────────────────────────────
//
// reconcileLocalToRemote() is the single owner of audioEl's clock and play
// state while casting. Every sync bug in this file's history was two handlers
// fighting over that ownership, so these tests pin its policy directly.

/**
 * Boot app.js into an active casting state.
 * @param remote - fields for the stubbed RemotePlayer (the receiver)
 * @param local  - { time, paused } for the sender's muted audioEl
 */
async function loadCastingApp(remote, local) {
  const { sandbox, evalIn, getElement, error } = await loadApp();
  assert.equal(error, null);

  const audio = getElement('audioPlayer');
  audio.src = 'episode.mp3';
  audio.currentTime = local.time;
  audio.paused = local.paused;
  audio.play = () => { audio.paused = false; return Promise.resolve(); };
  audio.pause = () => { audio.paused = true; };

  // castSession + remotePlayerController make _isCasting() true.
  evalIn(`
    castSession = {};
    remotePlayerController = {};
    remotePlayer = ${JSON.stringify(remote)};
  `);
  return { sandbox, evalIn, audio };
}

const LIVE = { currentTime: 100, duration: 500, isPaused: false };
const STOPPED = { currentTime: 100, duration: 500, isPaused: true };

test('reconciler snaps the local clock to the receiver while paused', async () => {
  // The pause overshoot: local halted 1.5s ahead of where the receiver stopped.
  // It must be corrected while paused, or resume starts out of sync.
  const { sandbox, audio } = await loadCastingApp(STOPPED, { time: 101.5, paused: true });
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.currentTime, 100, 'local must converge on the receiver');
  assert.equal(audio.paused, true, 'local must stay paused with the receiver');
});

test('reconciler leaves sub-tolerance drift alone', async () => {
  const { sandbox, audio } = await loadCastingApp(LIVE, { time: 100.2, paused: false });
  sandbox.resetRemoteClockGrace(Date.now());
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.currentTime, 100.2, 'no snap inside tolerance — avoids jitter');
});

test('reconciler does not resurrect local playback against a frozen receiver', async () => {
  // The 1s loop: a receiver-side pause can leave isPaused reading false while
  // the clock freezes. Restarting local playback then snapping it back replays
  // the same second forever. A stalled clock must win over the flag.
  const { sandbox, audio } = await loadCastingApp(LIVE, { time: 100, paused: true });
  // Age the clock past the stall timeout without it ever moving.
  sandbox.noteRemoteClock(100, Date.now() - 5000);
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.paused, true, 'must not resurrect against a frozen receiver');
});

test('reconciler resumes local playback for a genuinely advancing receiver', async () => {
  const { sandbox, audio } = await loadCastingApp(LIVE, { time: 100, paused: true });
  sandbox.resetRemoteClockGrace(Date.now());
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.paused, false, 'a live receiver must pull local playback along');
});

test('reconciler pauses local playback when the receiver pauses', async () => {
  const { sandbox, audio } = await loadCastingApp(STOPPED, { time: 100, paused: false });
  sandbox.resetRemoteClockGrace(Date.now());
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.paused, true, 'local must follow the receiver into pause');
});

test('reconciler is inert without an active Cast session', async () => {
  // Guard clauses matter: on the receiver the Cast framework owns audioEl, and
  // a stray reconcile would fight it.
  const { sandbox, evalIn, audio } = await loadCastingApp(LIVE, { time: 999, paused: true });
  evalIn('castSession = null;');
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.currentTime, 999, 'must not touch audioEl without a session');
  assert.equal(audio.paused, true);
});

test('reconciler ignores a receiver with no duration yet', async () => {
  // duration <= 0 means media has not loaded; its currentTime of 0 is not a
  // real position and snapping to it would rewind the sender to the start.
  const noMedia = { currentTime: 0, duration: 0, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(noMedia, { time: 50, paused: false });
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.currentTime, 50, 'must not rewind against unloaded media');
});
