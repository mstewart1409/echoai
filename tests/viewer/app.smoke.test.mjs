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
    // Media-readiness fields must be real values, not the Proxy's catch-all
    // function: the reconciler defers snapping while `seeking` is truthy, and a
    // function is truthy, which silently disabled every snap in these tests.
    seeking: false,
    readyState: 4,   // HAVE_ENOUGH_DATA — a loaded, settled element
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

// ── Snap thrash ──────────────────────────────────────────────────────────────
//
// Every snap seeks the local element; a seek forces a re-buffer; while it
// re-buffers the local clock stalls and the receiver's does not, so the drift
// comes straight back. Field logs showed this oscillating between 38.9s and
// 40.0s, dragging the transcript and its lazy translations around with it.

test('a second snap is refused inside the cooldown', async () => {
  const remote = { currentTime: 100, duration: 500, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 110, paused: false });
  sandbox.reconcileLocalToRemote('first');
  assert.equal(audio.currentTime, 100, 'first seek applies');

  audio.currentTime = 110;           // drift immediately reappears
  sandbox.reconcileLocalToRemote('second');
  assert.equal(audio.currentTime, 110, 'a seek must not follow straight after another');
});

test('snapping resumes once the cooldown expires', async () => {
  const remote = { currentTime: 100, duration: 500, isPaused: false };
  const { sandbox, evalIn, audio } = await loadCastingApp(remote, { time: 110, paused: false });
  sandbox.reconcileLocalToRemote('first');
  audio.currentTime = 110;
  evalIn('lastSnapAt = 0;');         // pretend the cooldown elapsed
  sandbox.reconcileLocalToRemote('later');
  assert.equal(audio.currentTime, 100, 'genuine drift is still corrected');
});

test('no snap while the element is seeking', async () => {
  // Seeking mid-seek is what fed the loop: it re-seeks before the first seek
  // has even settled.
  const remote = { currentTime: 100, duration: 500, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 110, paused: false });
  audio.seeking = true;
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.currentTime, 110, 'must wait for the in-flight seek');
});

test('no snap while the element is still buffering', async () => {
  const remote = { currentTime: 100, duration: 500, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 110, paused: false });
  audio.readyState = 1;   // HAVE_METADATA — not enough to play through
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.currentTime, 110, 'must wait for the buffer to fill');
});

// ── Drift correction policy ──────────────────────────────────────────────────
//
// Seeking empties the buffer, fires `waiting`, and makes the browser's native
// audio widget flash between play and paused — the reported flicker. It is the
// right tool only for a genuine jump.

test('small drift while playing is nudged, not seeked', async () => {
  const { sandbox } = await loadApp();
  assert.equal(sandbox.driftCorrection(101, 100, false), 'nudge');
  assert.equal(sandbox.driftCorrection(99, 100, false), 'nudge');
});

test('drift inside tolerance is left completely alone', async () => {
  const { sandbox } = await loadApp();
  assert.equal(sandbox.driftCorrection(100.3, 100, false), 'none');
});

test('a large jump is seeked', async () => {
  // An episode change or a user seek — worth the re-buffer.
  const { sandbox } = await loadApp();
  assert.equal(sandbox.driftCorrection(150, 100, false), 'seek');
});

test('a paused element is always seeked, never nudged', async () => {
  // playbackRate has no effect while paused, so nudging there would silently
  // never converge — this is what the pause-overshoot fix depends on.
  const { sandbox } = await loadApp();
  assert.equal(sandbox.driftCorrection(101.5, 100, true), 'seek');
});

test('the nudge runs slow when ahead and fast when behind', async () => {
  const { sandbox } = await loadApp();
  assert.ok(sandbox.nudgeRateFor(101, 100) < 1, 'ahead of the receiver → slow down');
  assert.ok(sandbox.nudgeRateFor(99, 100) > 1, 'behind the receiver → speed up');
});

test('nudging never touches currentTime', async () => {
  // The whole point: no seek, so no re-buffer and no widget flicker.
  const remote = { currentTime: 100, duration: 500, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 101, paused: false });
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.currentTime, 101, 'position must be untouched');
  assert.ok(audio.playbackRate < 1, 'correction happens via playback rate');
});

test('playback rate returns to normal once aligned', async () => {
  const remote = { currentTime: 100, duration: 500, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 101, paused: false });
  sandbox.reconcileLocalToRemote('drifted');
  assert.ok(audio.playbackRate < 1);
  audio.currentTime = 100;   // caught up
  sandbox.reconcileLocalToRemote('aligned');
  assert.equal(audio.playbackRate, 1, 'a nudge must not persist past convergence');
});

test('play state is held while a transport command is in flight', async () => {
  // The user pauses, we send the command, and the very next poll must not see
  // "remote still playing, local paused" and undo them.
  const remote = { currentTime: 100, duration: 500, isPaused: false };
  const { sandbox, evalIn, audio } = await loadCastingApp(remote, { time: 100, paused: true });
  evalIn('remotePlayerController = { playOrPause() {} }; commandedLocalPaused = false;');
  sandbox.mirrorLocalTransportToRemote();   // sends pause, opens the settle window
  sandbox.reconcileLocalToRemote('poll');
  assert.equal(audio.paused, true, 'the pause must survive until the receiver reports back');
});

// ── Receiver resume position ─────────────────────────────────────────────────
//
// The Cast framework's clock keeps advancing across a pause and it resumes from
// that, not from where the audio stopped. Field logs showed a pause at 39.16s
// resuming at 40.78s, so the transcript ran ~1.6s ahead of the audio.

test('resume is pulled back to the pinned pause position', async () => {
  const { sandbox } = await loadApp();
  // The exact numbers from the reported session.
  assert.equal(sandbox.shouldRestorePausePosition(39.16, 40.78), true);
});

test('resume within tolerance is left alone', async () => {
  const { sandbox } = await loadApp();
  assert.equal(
    sandbox.shouldRestorePausePosition(39.16, 39.3), false,
    'a sub-tolerance gap is not worth a visible correction'
  );
});

test('no pin means no correction', async () => {
  const { sandbox } = await loadApp();
  assert.equal(sandbox.shouldRestorePausePosition(null, 100), false);
});

test('a large gap is treated as a seek, not clock drift', async () => {
  // The user seeking while paused must win — yanking them back would be worse
  // than the drift this is here to fix.
  const { sandbox } = await loadApp();
  assert.equal(sandbox.shouldRestorePausePosition(39.16, 600), false);
});

test('a backward gap is corrected too', async () => {
  const { sandbox } = await loadApp();
  assert.equal(sandbox.shouldRestorePausePosition(40.78, 39.16), true);
});

// ── Bidirectional transport ──────────────────────────────────────────────────
//
// The reconciler alone makes the sender's native <audio> controls read-only
// while casting: a manual pause is undone within 500ms because the reconciler
// sees the receiver still playing. User intent has to travel the other way.

test('a user pause on the sender is forwarded to the receiver', async () => {
  const { sandbox } = await loadApp();
  // local paused, remote playing, reconciler last commanded PLAYING → user did it.
  assert.equal(sandbox.shouldMirrorTransport(true, false, false), true);
});

test('a user play on the sender is forwarded to the receiver', async () => {
  const { sandbox } = await loadApp();
  assert.equal(sandbox.shouldMirrorTransport(false, true, true), true);
});

test('the reconcilers own transport writes are not mirrored back', async () => {
  // Without this the reconciler pausing the local element would bounce a
  // command to the receiver, pausing playback the user never touched.
  const { sandbox } = await loadApp();
  assert.equal(sandbox.shouldMirrorTransport(true, false, true), false);
  assert.equal(sandbox.shouldMirrorTransport(false, true, false), false);
});

test('nothing is mirrored when both ends already agree', async () => {
  // playOrPause() is a toggle — forwarding when states match would drive the
  // receiver into the wrong state rather than keeping it aligned.
  const { sandbox } = await loadApp();
  assert.equal(sandbox.shouldMirrorTransport(false, false, true), false);
  assert.equal(sandbox.shouldMirrorTransport(true, true, false), false);
});

test('a user pause is recognised even right after the reconciler acted', async () => {
  // The regression this replaced: echo suppression used a 250ms time window, so
  // on a buffering Pi the reconciler had almost always just acted and real
  // pauses were swallowed. Intent comparison has no timing component.
  const { sandbox, evalIn } = await loadApp();
  evalIn(`
    castSession = {};
    remotePlayerController = { playOrPause() { globalThis.__toggles = (globalThis.__toggles || 0) + 1; } };
    remotePlayer = { currentTime: 10, duration: 500, isPaused: false };
    globalThis.__toggles = 0;
    commandedLocalPaused = false;
  `);
  sandbox.markProgrammaticTransport(false);   // reconciler acted this instant
  sandbox.mirrorLocalTransportToRemote();     // audioEl stub is paused = user pause
  assert.equal(sandbox.__toggles, 1, 'a real pause must still reach the receiver');
});

test('the reconcilers own pause does not reach the receiver', async () => {
  const { sandbox, evalIn } = await loadApp();
  evalIn(`
    castSession = {};
    remotePlayerController = { playOrPause() { globalThis.__toggles = (globalThis.__toggles || 0) + 1; } };
    remotePlayer = { currentTime: 10, duration: 500, isPaused: false };
    globalThis.__toggles = 0;
    commandedLocalPaused = true;
  `);
  sandbox.mirrorLocalTransportToRemote();
  assert.equal(sandbox.__toggles, 0);
});

test('mirroring is inert without a Cast session', async () => {
  const { sandbox, evalIn } = await loadApp();
  evalIn(`
    castSession = null;
    remotePlayerController = { playOrPause() { globalThis.__toggles = (globalThis.__toggles || 0) + 1; } };
    remotePlayer = { currentTime: 10, duration: 500, isPaused: false };
    globalThis.__toggles = 0;
  `);
  sandbox.mirrorLocalTransportToRemote();
  assert.equal(sandbox.__toggles, 0);
});

// ── Episode transitions ──────────────────────────────────────────────────────
//
// Mid-changeover the two ends describe DIFFERENT media. Reconciling then took
// the receiver's position in the OLD episode and applied it to the NEW one.

test('reconciliation is suspended during an episode change', async () => {
  // Receiver still reporting the old episode at 500s; sender already on the new
  // one at 0s. Without the guard the new episode is yanked to 500s.
  const remote = { currentTime: 500, duration: 1800, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 0, paused: false });
  sandbox.beginEpisodeTransition('test', true);
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.currentTime, 0, 'must not drag the new episode to the old position');
});

test('reconciliation resumes once the transition ends', async () => {
  const remote = { currentTime: 500, duration: 1800, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 0, paused: false });
  sandbox.beginEpisodeTransition('test', true);
  sandbox.endEpisodeTransition('test');
  sandbox.reconcileLocalToRemote('test');
  assert.equal(audio.currentTime, 500, 'normal convergence must return');
});

test('a transition expires on its own so sync can never stay stuck', async () => {
  const { sandbox, evalIn } = await loadApp();
  sandbox.beginEpisodeTransition('test', true);
  assert.equal(sandbox.isEpisodeTransitionActive(Date.now()), true);
  // A lost loadMedia callback must not suspend sync forever.
  evalIn('castTransitionUntil = Date.now() - 1;');
  assert.equal(sandbox.isEpisodeTransitionActive(Date.now()), false);
});

test('ending a transition resets the remote clock tracker', async () => {
  // The old episode's clock readings must not make the new one look stalled.
  const { sandbox, evalIn } = await loadApp();
  sandbox.beginEpisodeTransition('test', true);
  evalIn('lastRemoteTime = 500;');
  sandbox.endEpisodeTransition('test');
  // Top-level `let` bindings are not sandbox properties — read them in-context.
  assert.equal(evalIn('lastRemoteTime'), -1);
  assert.equal(sandbox.remoteIsMoving(Date.now()), true, 'new media starts optimistic');
});

test('endEpisodeTransition is a no-op when none is active', async () => {
  const { sandbox } = await loadApp();
  sandbox.endEpisodeTransition('test');  // must not throw
  assert.equal(sandbox.isEpisodeTransitionActive(Date.now()), false);
});

// ── Cast handover ────────────────────────────────────────────────────────────
//
// Starting a cast is a handover, not a fork. The sender used to play on through
// the token mint and LOAD round trip, ending up seconds ahead, and was then
// dragged backwards when the receiver finally reported in.

test('starting a cast parks the sender', async () => {
  const { sandbox, getElement } = await loadApp();
  const audio = getElement('audioPlayer');
  audio.paused = false;
  audio.currentTime = 250;
  audio.pause = () => { audio.paused = true; };

  sandbox.parkSenderForHandover('cast handover');

  assert.equal(audio.paused, true, 'sender must stop so the position stays put');
  assert.equal(audio.currentTime, 250, 'and must not move while parked');
  assert.equal(sandbox.isEpisodeTransitionActive(Date.now()), true, 'sync stays suspended');
});

test('parking is idempotent when already paused', async () => {
  const { sandbox, getElement } = await loadApp();
  const audio = getElement('audioPlayer');
  audio.paused = true;
  audio.currentTime = 250;
  sandbox.parkSenderForHandover('cast handover');
  assert.equal(audio.currentTime, 250);
});

test('the parked sender is not resumed while the handover is in flight', async () => {
  // setupCastSync kick-starts local playback; during a handover that would
  // undo the park microseconds after it was applied.
  const remote = { currentTime: 250, duration: 1800, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 250, paused: true });
  sandbox.parkSenderForHandover('cast handover');
  sandbox.reconcileLocalToRemote('poll');
  assert.equal(audio.paused, true, 'must stay parked until the receiver confirms');
});

test('the sender resumes once the receiver confirms the load', async () => {
  const remote = { currentTime: 250, duration: 1800, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 250, paused: true });
  sandbox.parkSenderForHandover('cast handover');
  sandbox.endEpisodeTransition('loadMedia ok');
  sandbox.reconcileLocalToRemote('poll');
  assert.equal(audio.paused, false, 'playback follows the receiver again');
});

test('a parked sender is aligned to the receiver before resuming', async () => {
  // The receiver has moved on a little during the load; a paused element can
  // only be corrected by seeking, so it must land exactly, not nudge.
  const remote = { currentTime: 253, duration: 1800, isPaused: false };
  const { sandbox, audio } = await loadCastingApp(remote, { time: 250, paused: true });
  sandbox.parkSenderForHandover('cast handover');
  sandbox.endEpisodeTransition('loadMedia ok');
  sandbox.reconcileLocalToRemote('poll');
  assert.equal(audio.currentTime, 253, 'handover lands on the receiver position');
});

test('nothing can resume a parked sender, whoever calls', async () => {
  // The guard lives in _ensureLocalMutedPlayback rather than at one call site,
  // so setupCastSync's kick-start (and any future caller) cannot undo a park.
  const { sandbox, getElement } = await loadApp();
  const audio = getElement('audioPlayer');
  audio.src = 'episode.mp3';
  audio.paused = true;
  audio.play = () => { audio.paused = false; return Promise.resolve(); };

  sandbox.parkSenderForHandover('cast handover');
  sandbox._ensureLocalMutedPlayback();
  assert.equal(audio.paused, true, 'the park must survive a direct resume call');

  sandbox.endEpisodeTransition('loadMedia ok');
  sandbox._ensureLocalMutedPlayback();
  assert.equal(audio.paused, false, 'and normal resumption still works after');
});

// ── Log verbosity ────────────────────────────────────────────────────────────
//
// Volume is bounded on two sides: the server caps client entries per minute and
// the log file rotates within a few MB. Verbose traces must therefore stay off
// unless asked for, or they evict the events worth keeping.

test('debug traces are suppressed by default', async () => {
  const { sandbox, evalIn } = await loadApp();
  evalIn('castLogEntries.length = 0;');
  sandbox.castLogDebug('a high-frequency trace');
  assert.equal(evalIn('castLogEntries.length'), 0, 'DEBUG must not log without ?verbose=1');
});

test('debug traces are emitted with ?verbose=1', async () => {
  const { sandbox, evalIn } = await loadApp('?verbose=1');
  evalIn('castLogEntries.length = 0;');
  sandbox.castLogDebug('a high-frequency trace');
  assert.equal(evalIn('castLogEntries.length'), 1);
  assert.equal(evalIn('castLogEntries[0].level'), 'DEBUG');
});

test('normal logs are never suppressed', async () => {
  // State changes and decisions must survive without verbose mode.
  const { sandbox, evalIn } = await loadApp();
  evalIn('castLogEntries.length = 0;');
  sandbox.castLog('INFO', 'a state change');
  assert.equal(evalIn('castLogEntries.length'), 1);
});

test('the heartbeat reports sender state without a cast session', async () => {
  const { sandbox, evalIn } = await loadApp();
  evalIn('castLogEntries.length = 0; castSession = null;');
  sandbox.logSyncHeartbeat();
  const msg = evalIn('castLogEntries[0].msg');
  assert.match(msg, /^hb sender:/);
  assert.match(msg, /casting=no/);
});

test('the heartbeat reports drift and transition state while casting', async () => {
  // This one line is what makes a desync reconstructable after the fact.
  const { sandbox, evalIn } = await loadCastingApp(
    { currentTime: 100, duration: 500, isPaused: false }, { time: 102, paused: false }
  );
  evalIn('castLogEntries.length = 0;');
  sandbox.logSyncHeartbeat();
  const msg = evalIn('castLogEntries[0].msg');
  assert.match(msg, /casting=yes/);
  assert.match(msg, /drift=2\.00s/);
  assert.match(msg, /transition=/);
});

test('the heartbeat never throws in receiver mode', async () => {
  const { sandbox, evalIn } = await loadApp('?mode=receiver');
  evalIn('castLogEntries.length = 0;');
  sandbox.logSyncHeartbeat();
  assert.match(evalIn('castLogEntries[0].msg'), /^hb receiver:/);
});
