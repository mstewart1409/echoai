import argparse
import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from logging.handlers import RotatingFileHandler

import requests
import spacy
from pathlib import Path
from dotenv import load_dotenv

from flask import Flask, g, jsonify, make_response, request, send_from_directory

from echoai import __version__

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE_DIR = PROJECT_ROOT
load_dotenv(PROJECT_ROOT / '.env')


def env_int(name: str, default: int) -> int:
    """Read an integer env var, falling back to the default on anything unusable."""
    try:
        return int(os.getenv(name, ''))
    except ValueError:
        return default


DOWNLOADS_DIR = Path(
    os.getenv('TRANSCRIPT_VIEWER_DOWNLOADS_DIR', str(DEFAULT_BASE_DIR / 'downloads'))
).resolve()
TRANSCRIPTS_DIR = Path(
    os.getenv('TRANSCRIPT_VIEWER_TRANSCRIPTS_DIR', str(DEFAULT_BASE_DIR / 'transcripts'))
).resolve()
VIEWER_DIR = Path(
    os.getenv('TRANSCRIPT_VIEWER_STATIC_DIR', str(DEFAULT_BASE_DIR / 'echoai' / 'viewer'))
).resolve()
SPACY_MODEL = os.getenv('TRANSCRIPT_VIEWER_SPACY_MODEL', 'de_core_news_sm')
CAST_RECEIVER_APP_ID = os.getenv('TRANSCRIPT_VIEWER_CAST_RECEIVER_APP_ID', '')
AUTH_DISABLED = os.getenv('TRANSCRIPT_VIEWER_AUTH_DISABLED', '').strip().lower() in ('1', 'true')
AUTH_USERNAME = os.getenv('TRANSCRIPT_VIEWER_AUTH_USERNAME', '').strip()
AUTH_PASSWORD = os.getenv('TRANSCRIPT_VIEWER_AUTH_PASSWORD', '').strip()
CAST_SIGNING_KEY = os.getenv('TRANSCRIPT_VIEWER_CAST_SIGNING_KEY', AUTH_PASSWORD).strip()
AUTH_SESSION_SECRET = os.getenv('TRANSCRIPT_VIEWER_AUTH_SESSION_SECRET', CAST_SIGNING_KEY).strip()
AUTH_SESSION_COOKIE_NAME = 'tv_session'
COOKIE_SECURE = os.getenv('TRANSCRIPT_VIEWER_COOKIE_SECURE', '1').strip().lower() not in (
    '0',
    'false',
)
# Must comfortably exceed one episode: the media URL handed to the Chromecast
# embeds this token and is never rewritten, so a seek after expiry would 401.
# Refresh still runs at 80% TTL for the receiver's API calls.
CAST_TOKEN_TTL_SECONDS = env_int('TRANSCRIPT_VIEWER_CAST_TOKEN_TTL_SECONDS', 10800)
AUTH_SESSION_TTL_SECONDS = env_int('TRANSCRIPT_VIEWER_AUTH_SESSION_TTL_SECONDS', 86400)
CAST_TOKEN_REQUIRED_FOR_MEDIA = (
    os.getenv('TRANSCRIPT_VIEWER_CAST_TOKEN_REQUIRED_FOR_MEDIA', '0') == '1'
)

# ── Logging ──────────────────────────────────────────────────────────────────
# The container root filesystem is read-only with only /tmp writable, so the
# log file lives there by default. It is therefore lost on redeploy — that is
# accepted: these are debugging logs, not an audit trail.
LOG_LEVEL = os.getenv('TRANSCRIPT_VIEWER_LOG_LEVEL', 'INFO').strip().upper()
LOG_FILE = os.getenv('TRANSCRIPT_VIEWER_LOG_FILE', '/tmp/echoai.log').strip()
# Rotation keeps disk use bounded at roughly MAX_BYTES * (BACKUP_COUNT + 1).
LOG_MAX_BYTES = env_int('TRANSCRIPT_VIEWER_LOG_MAX_BYTES', 2_000_000)
LOG_BACKUP_COUNT = env_int('TRANSCRIPT_VIEWER_LOG_BACKUP_COUNT', 3)
LOG_FORMAT = '%(asctime)s %(levelname)s %(name)s %(message)s'

# Caps for the log-viewing API. The viewer never streams the whole file.
LOG_TAIL_MAX_BYTES = 2_000_000
LOG_API_MAX_LINES = 2000
LOG_API_DEFAULT_LINES = 500

# Caps for client-side (browser / Chromecast) log ingestion.
CLIENT_LOG_MAX_ENTRIES = 50
CLIENT_LOG_MAX_MSG_LEN = 1000
CLIENT_LOG_LEVELS = frozenset({'DEBUG', 'INFO', 'OK', 'WARN', 'ERROR'})
# Flood ceiling: a client that spams logs would rotate real evidence out of the
# file. Generous enough for genuine debugging, low enough to bound the damage.
CLIENT_LOG_RATE_MAX_ENTRIES = 600
CLIENT_LOG_RATE_WINDOW_SECONDS = 60

# Largest request body accepted on ANY endpoint. Without this a single huge
# POST is parsed into memory and can OOM the 512 MB container.
MAX_CONTENT_LENGTH = 256 * 1024


# Bounded caches — prevent unbounded memory growth.
CACHE_MAX_SIZE = 10000
AUTH_SESSIONS_MAX = 1000

# Maximum input lengths for translation/analysis endpoints.
TRANSLATE_TEXT_MAX_LEN = 500
TRANSLATE_WORD_MAX_LEN = 80

# Regex for safe episode IDs — letters, digits, hyphens, underscores only.
_SAFE_EPISODE_ID_RE = re.compile(r'^[A-Za-z0-9_-]+$')

# Token scope meaning "any episode" - used for the Cast receiver's session token,
# which must also cover episodes the receiver picks on-device.
CAST_SCOPE_ANY = '_auth'

# Routes a cast token must NOT unlock - they require a logged-in session.
# The log viewer is in here deliberately: logs are diagnostics, and a cast
# token lives on a TV that anyone in the room can reach.
SESSION_ONLY_PATHS = frozenset({'/api/cast/session', '/api/cast/debug', '/api/logs'})

# Page shells gated by HTTP Basic auth, so the browser's own sign-in dialog
# appears before any markup renders. Everything else authenticates by session
# cookie or cast token.
PAGE_SHELL_PATHS = frozenset({'/', '/logs'})

# The ONLY path the Chromecast may fetch unauthenticated. Kept separate from
# PAGE_SHELL_PATHS on purpose: the receiver exemption must not extend to /logs.
RECEIVER_SHELL_PATH = '/'

# Explicitly named rather than __name__: under `python -m echoai.transcript_viewer`
# __name__ is '__main__', which would make server logs unfilterable by source in
# the /logs viewer and inconsistent between run styles.
logger = logging.getLogger('echoai.server')
# Client (browser / Chromecast) logs shipped to /api/logs/client land here, so
# they are distinguishable from server logs by name in the viewer.
client_logger = logging.getLogger('echoai.client')

# Query parameters whose values must never reach a log file. `rt` is a signed
# cast token: logging it would hand out media access to anyone reading logs.
_REDACTED_QUERY_KEYS = frozenset({'rt', 'token', 'password', 'secret', 'key'})
# Matches a full log line written with LOG_FORMAT.
_LOG_LINE_RE = re.compile(
    r'^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+'
    r'(?P<level>[A-Z]+)\s+'
    r'(?P<name>\S+)\s+'
    r'(?P<message>.*)$'
)


REDACTED = '<redacted>'

# Structural patterns for secrets, applied to every log line by RedactingFormatter.
# Each is deliberately narrow enough not to eat ordinary values (episode ids,
# filenames, versions, paths).
_REDACTION_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # key=value in a query string or body fragment: rt=..., password=..., token=...
    (
        re.compile(
            r'\b(rt|token|password|passwd|secret|api_?key|signing_?key|sid|session)'
            r'\s*[=:]\s*"?([^\s&"\',;]+)',
            re.IGNORECASE,
        ),
        r'\1=' + REDACTED,
    ),
    # Authorization headers: "Bearer <token>" / "Basic <blob>".
    (re.compile(r'\b(Bearer|Basic)\s+\S+', re.IGNORECASE), r'\1 ' + REDACTED),
    # Cast token: base64url payload "." base64url signature. BOTH halves must be
    # long, so "123_egp654.mp3" and "echoai.log" are untouched.
    (re.compile(r'\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b'), REDACTED),
    # Session ids and raw keys: any long hex run (a sha256 hexdigest is 64).
    (re.compile(r'\b[0-9a-fA-F]{32,}\b'), REDACTED),
)


def _configured_secrets() -> list[str]:
    """The live secret values, read at call time so tests and reloads stay correct.

    Scrubbing by exact value is the backstop: even if a future call site logs
    the real password, it never reaches the file. Short values are skipped — an
    8-character floor stops a weak secret from redacting half of English.
    """
    return [s for s in (AUTH_PASSWORD, AUTH_SESSION_SECRET, CAST_SIGNING_KEY) if s and len(s) >= 8]


def scrub_secrets(text: str) -> str:
    """Remove anything secret-shaped from a log line.

    Applied to every record by RedactingFormatter, so it covers the message,
    its arguments, and any attached traceback — including logs shipped from the
    browser and the Chromecast, which are entirely attacker-controlled.
    """
    if not text:
        return text
    for secret in _configured_secrets():
        text = text.replace(secret, REDACTED)
    for pattern, replacement in _REDACTION_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class RedactingFormatter(logging.Formatter):
    """Formatter that scrubs secrets from the fully rendered line.

    The single chokepoint: every handler uses it, so no call site can leak by
    forgetting to redact, and a traceback carrying a tokenised URL is covered
    too (tracebacks render here, not in the record's own message).
    """

    def format(self, record: logging.LogRecord) -> str:
        return scrub_secrets(super().format(record))


# Every character Python's str.splitlines() treats as a line break, plus the C1
# range and DEL. Stripping only \r\n is NOT enough: \x0b, \x0c, \x1c-\x1e, \x85,
# U+2028 and U+2029 all split lines too, so a client could inject a fake
# timestamped record into the log file and forge entries attributed to any
# logger. \x1b is in here as well, which also neutralises ANSI escape sequences
# that would otherwise rewrite the terminal of anyone running `docker logs`.
_UNSAFE_LOG_CHARS_RE = re.compile(r'[\x00-\x1f\x7f-\x9f\u2028\u2029]')


def sanitize_log_text(text: str) -> str:
    """Make attacker-supplied text safe to write as a single log record."""
    return _UNSAFE_LOG_CHARS_RE.sub(' ', text)


def _redact_query(query: str) -> str:
    """Blank the values of sensitive query parameters before logging a URL."""
    if not query:
        return ''
    parts = []
    for pair in query.split('&'):
        key, sep, _value = pair.partition('=')
        if sep and key.lower() in _REDACTED_QUERY_KEYS:
            parts.append(f'{key}={REDACTED}')
        else:
            parts.append(pair)
    return '&'.join(parts)


def _configure_logging() -> None:
    """Send logs to stderr and, when possible, to a rotating file for the viewer.

    A failure to open the log file is never fatal — the app must still serve
    even on a filesystem where the configured path is not writable.
    """
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    file_error: str | None = None
    if LOG_FILE:
        try:
            Path(LOG_FILE).parent.mkdir(parents=True, exist_ok=True)
            handlers.append(
                RotatingFileHandler(
                    LOG_FILE,
                    maxBytes=LOG_MAX_BYTES,
                    backupCount=LOG_BACKUP_COUNT,
                    encoding='utf-8',
                )
            )
        except OSError as exc:
            file_error = f'{type(exc).__name__}: {exc}'

    formatter = RedactingFormatter(LOG_FORMAT)
    for handler in handlers:
        handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(LOG_LEVEL if LOG_LEVEL in logging.getLevelNamesMapping() else 'INFO')
    for existing in list(root.handlers):
        root.removeHandler(existing)
    for handler in handlers:
        root.addHandler(handler)

    if file_error:
        logger.warning('log file %s unavailable (%s) — console only', LOG_FILE, file_error)
    else:
        logger.info(
            'logging to %s (level=%s, rotate=%d bytes x %d)',
            LOG_FILE or '<console only>',
            LOG_LEVEL,
            LOG_MAX_BYTES,
            LOG_BACKUP_COUNT,
        )

    # Werkzeug's access log writes the RAW request line, query string and all.
    # Media URLs carry a signed cast token in `rt`, so leaving it enabled would
    # write live media credentials into a file the /logs page serves back out.
    # log_request() above already covers every request, with the query redacted
    # and a duration attached, so this only silences a leaky duplicate.
    logging.getLogger('werkzeug').setLevel(logging.ERROR)


def _validate_episode_id(episode_id: str) -> str | None:
    """Return sanitised episode_id or None if invalid."""
    episode_id = episode_id.strip()
    if not episode_id or not _SAFE_EPISODE_ID_RE.fullmatch(episode_id):
        return None
    return episode_id


def _pick_dir(
    configured: Path,
    local_default: Path,
    label: str,
    usable: Callable[[Path], bool],
) -> Path:
    """Prefer the configured dir, else fall back to the local project dir.

    `usable` decides what "good enough" means — the directory merely existing,
    containing index.html, or containing matching content files.
    """
    if configured == local_default or usable(configured):
        return configured
    if usable(local_default):
        logger.warning('%s path %s unusable; falling back to %s', label, configured, local_default)
        return local_default
    return configured


def _has_file(name: str) -> Callable[[Path], bool]:
    return lambda p: (p / name).exists()


def _has_content(pattern: str) -> Callable[[Path], bool]:
    return lambda p: p.exists() and any(p.glob(pattern))


DOWNLOADS_DIR = _pick_dir(
    DOWNLOADS_DIR, DEFAULT_BASE_DIR / 'downloads', 'Downloads', _has_content('*.mp3')
)
TRANSCRIPTS_DIR = _pick_dir(
    TRANSCRIPTS_DIR, DEFAULT_BASE_DIR / 'transcripts', 'Transcripts', _has_content('*.*')
)
VIEWER_DIR = _pick_dir(
    VIEWER_DIR, DEFAULT_BASE_DIR / 'echoai' / 'viewer', 'Viewer static', _has_file('index.html')
)

app = Flask(__name__, static_folder=str(VIEWER_DIR), static_url_path='/static')
# Reject oversized bodies before Flask parses them into memory. Every POST this
# app accepts is small (credentials, a log batch, an episode id), so a body
# above this is either a bug or an attempt to exhaust the 512 MB container.
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

# Host sources are deliberately scheme-less: the Cast SDK <script> URLs are
# protocol-relative (Google's documented best practice), so pinning https:// here
# would block the SDK entirely on an http:// LAN deployment — the exact setup
# docs/CHROMECAST.md prescribes for Tier-2 testing. A scheme-less host matches
# the page's own scheme.
CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' "
    'www.gstatic.com *.gstatic.com '
    'ajax.googleapis.com '
    'static.cloudflareinsights.com; '
    "style-src 'self' 'unsafe-inline'; "
    # ws://localhost:* is how the CAF receiver reaches the local Cast platform.
    "connect-src 'self' ws://localhost:* wss://localhost:* "
    '*.google.com *.googleapis.com *.gstatic.com '
    '*.cloudflareinsights.com; '
    "media-src 'self' blob:; "
    "img-src 'self' data: blob:; "
    "font-src 'self';"
)


@app.after_request
def apply_security_headers(response):
    """Attach security headers to all responses."""
    # CSP on HTML only.
    content_type = response.content_type or ''
    if 'text/html' in content_type:
        response.headers['Content-Security-Policy'] = CSP_POLICY

    # Universal security headers.
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
    if COOKIE_SECURE:
        response.headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains'

    # Prevent caching of authenticated API responses.
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'

    return response


# ── Bounded cache helper ──────────────────────────────────────────────────────


class BoundedCache:
    """Thread-safe LRU dict with a configurable max size."""

    def __init__(self, max_size: int = 10000) -> None:
        self._data: OrderedDict[str, object] = OrderedDict()
        self._max = max_size
        self._lock = threading.Lock()

    def get(self, key: str) -> object | None:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                return self._data[key]
        return None

    def set(self, key: str, value: object) -> None:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
            self._data[key] = value
            while len(self._data) > self._max:
                self._data.popitem(last=False)

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


TEXT_TRANSLATION_CACHE: BoundedCache = BoundedCache(CACHE_MAX_SIZE)
ANALYSIS_CACHE: BoundedCache = BoundedCache(CACHE_MAX_SIZE)
AUTH_SESSIONS: dict[str, int] = {}
AUTH_SESSIONS_LOCK = threading.Lock()


def _has_auth_credentials_configured() -> bool:
    return bool(AUTH_USERNAME and AUTH_PASSWORD and AUTH_SESSION_SECRET)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _b64url_decode(raw: str) -> bytes:
    padding = '=' * (-len(raw) % 4)
    return base64.urlsafe_b64decode((raw + padding).encode('ascii'))


def _validate_login_credentials(username: str, password: str) -> bool:
    return hmac.compare_digest(username, AUTH_USERNAME) and hmac.compare_digest(
        password, AUTH_PASSWORD
    )


def _new_auth_session(username: str) -> tuple[str, int]:
    now = int(time.time())
    sid_payload = f'{username}:{now}:{secrets.token_urlsafe(16)}'
    sid_sig = hmac.new(
        AUTH_SESSION_SECRET.encode('utf-8'), sid_payload.encode('utf-8'), hashlib.sha256
    ).hexdigest()
    sid = f'{sid_payload}:{sid_sig}'
    expires_at = now + max(300, AUTH_SESSION_TTL_SECONDS)
    with AUTH_SESSIONS_LOCK:
        # Proactive reaping: evict expired sessions before adding new one.
        _reap_expired_sessions_locked(now)
        # Enforce max session count.
        if len(AUTH_SESSIONS) >= AUTH_SESSIONS_MAX:
            oldest_sid = min(AUTH_SESSIONS, key=AUTH_SESSIONS.get)
            AUTH_SESSIONS.pop(oldest_sid, None)
        AUTH_SESSIONS[sid] = expires_at
    return sid, expires_at


def _reap_expired_sessions_locked(now: int | None = None) -> int:
    """Remove expired sessions. Must be called with AUTH_SESSIONS_LOCK held."""
    if now is None:
        now = int(time.time())
    expired = [sid for sid, exp in AUTH_SESSIONS.items() if exp < now]
    for sid in expired:
        del AUTH_SESSIONS[sid]
    return len(expired)


def _delete_auth_session(sid: str | None) -> None:
    if not sid:
        return
    with AUTH_SESSIONS_LOCK:
        AUTH_SESSIONS.pop(sid, None)


def _validate_auth_session() -> bool:
    sid = request.cookies.get(AUTH_SESSION_COOKIE_NAME)
    if not sid:
        return False

    now = int(time.time())
    with AUTH_SESSIONS_LOCK:
        expires_at = AUTH_SESSIONS.get(sid)
        if not isinstance(expires_at, int):
            return False
        if expires_at < now:
            AUTH_SESSIONS.pop(sid, None)
            return False
    return True


def _auth_required_response() -> tuple[dict, int]:
    return {'error': 'authentication required'}, 401


def _mint_cast_token(episode_id: str) -> tuple[str, int]:
    now = int(time.time())
    payload = {
        'ep': episode_id,
        'exp': now + max(30, CAST_TOKEN_TTL_SECONDS),
        'nonce': secrets.token_hex(8),
    }
    payload_bytes = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    payload_b64 = _b64url_encode(payload_bytes)
    signature = hmac.new(
        CAST_SIGNING_KEY.encode('utf-8'), payload_b64.encode('ascii'), hashlib.sha256
    ).digest()
    return f'{payload_b64}.{_b64url_encode(signature)}', payload['exp']


def _verify_cast_token(token: str) -> dict | None:
    if not token or '.' not in token or not CAST_SIGNING_KEY:
        return None
    payload_b64, sig_b64 = token.split('.', 1)
    try:
        provided_sig = _b64url_decode(sig_b64)
    except ValueError, binascii.Error:
        return None
    expected_sig = hmac.new(
        CAST_SIGNING_KEY.encode('utf-8'), payload_b64.encode('ascii'), hashlib.sha256
    ).digest()
    if not hmac.compare_digest(provided_sig, expected_sig):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_b64).decode('utf-8'))
    except ValueError, UnicodeDecodeError, json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    expires_at = payload.get('exp')
    if not isinstance(expires_at, int) or expires_at < int(time.time()):
        return None
    return payload


def _extract_cast_token_from_request() -> str:
    token = (request.args.get('rt') or '').strip()
    if token:
        return token

    cast_header = (request.headers.get('X-Cast-Token') or '').strip()
    if cast_header:
        return cast_header

    bearer = (request.headers.get('Authorization') or '').strip()
    if bearer.startswith('Bearer '):
        return bearer[7:].strip()

    if request.path == '/api/cast/validate' and request.method == 'POST':
        payload = request.get_json(silent=True) or {}
        json_token = str(payload.get('token', '')).strip()
        if json_token:
            return json_token

    return (request.headers.get('X-Cast-Token') or '').strip()


@app.before_request
def start_request_timer():
    """Stamp the request so after_request can report how long it took."""
    request.environ['echoai.start_time'] = time.monotonic()


@app.after_request
def log_request(response):
    """One line per request — the backbone of after-the-fact debugging.

    Query strings are redacted: media URLs carry a signed cast token in `rt`,
    and a log file is not a place to store credentials.
    """
    started = request.environ.get('echoai.start_time')
    duration_ms = (time.monotonic() - started) * 1000 if started else -1
    query = _redact_query(request.query_string.decode('utf-8', 'replace'))
    # 4xx/5xx are the interesting ones — surface them above INFO noise.
    level = logging.WARNING if response.status_code >= 400 else logging.INFO
    logger.log(
        level,
        '%s %s%s → %d (%.0fms) from %s',
        request.method,
        request.path,
        f'?{query}' if query else '',
        response.status_code,
        duration_ms,
        request.remote_addr or '-',
    )
    return response


def _is_receiver_shell_request() -> bool:
    """Is this the Chromecast fetching the app shell?

    The receiver runs on a TV: it has no cookie jar and no way to answer a Basic
    auth challenge, so the shell must stay reachable for it. That is safe — the
    shell is static markup with no episode data, and every API call it then
    makes still needs a signed cast token.
    """
    return request.args.get('mode') == 'receiver' or request.args.get('receiver') == '1'


def _validate_basic_auth() -> bool:
    """Check an HTTP Basic Authorization header against the configured credentials.

    Lets the browser put its native sign-in dialog in front of the page, so the
    app shell never renders for an unauthenticated visitor.
    """
    header = request.headers.get('Authorization', '')
    if not header.startswith('Basic '):
        return False
    try:
        decoded = base64.b64decode(header[6:].strip(), validate=True).decode('utf-8')
    except ValueError, binascii.Error, UnicodeDecodeError:
        return False
    username, sep, password = decoded.partition(':')
    if not sep:
        return False
    return _validate_login_credentials(username.strip(), password.strip())


def _basic_auth_challenge():
    """401 that makes the browser show its own login dialog."""
    response = make_response(jsonify({'error': 'authentication required'}), 401)
    response.headers['WWW-Authenticate'] = 'Basic realm="echoai", charset="UTF-8"'
    return response


@app.before_request
def require_authentication():
    if AUTH_DISABLED:
        return None

    # Static assets stay public: the Chromecast receiver needs the CSS and JS,
    # and they contain no episode data.
    if request.path.startswith('/static/'):
        return None

    if request.path in ('/api/auth/status', '/api/auth/login'):
        return None

    if _validate_auth_session():
        return None

    # Page shells are gated by HTTP Basic so nothing renders before sign-in.
    # On success we mint a session cookie (see _issue_session_after_basic_auth)
    # so the page's own API calls work without re-sending credentials.
    if request.path in PAGE_SHELL_PATHS:
        # The receiver exemption applies to the viewer shell ONLY. Scoping it to
        # PAGE_SHELL_PATHS as a whole let `/logs?mode=receiver` walk straight
        # past the gate — and the Chromecast never loads /logs.
        if request.path == RECEIVER_SHELL_PATH and _is_receiver_shell_request():
            return None
        if not _has_auth_credentials_configured():
            # Nothing to check against — challenging would lock the app shut.
            return None
        if _validate_basic_auth():
            g.issue_session_for = AUTH_USERNAME
            return None
        return _basic_auth_challenge()

    # Basic credentials are accepted on API calls too, so a client that already
    # answered the browser dialog is not forced through a second login.
    if _validate_basic_auth():
        return None

    # A cast token authenticates the receiver for content only. It must never
    # authenticate token minting (which would make the TTL meaningless) or
    # diagnostics. Those require a real logged-in session.
    if request.path in SESSION_ONLY_PATHS:
        return _auth_required_response()

    token_claims = _verify_cast_token(_extract_cast_token_from_request())
    if token_claims is not None:
        return None

    return _auth_required_response()


@app.after_request
def _issue_session_after_basic_auth(response):
    """Convert a successful Basic auth on a page load into a normal session cookie.

    Without this the browser would have to attach credentials to every XHR the
    page makes; with it, Basic auth is a one-time gate and everything after runs
    on the same session mechanism as a form login.
    """
    username = getattr(g, 'issue_session_for', None)
    if not username:
        return response
    sid, _expires_at = _new_auth_session(username)
    response.set_cookie(
        AUTH_SESSION_COOKIE_NAME,
        sid,
        max_age=max(300, AUTH_SESSION_TTL_SECONDS),
        httponly=True,
        samesite='Lax',
        secure=COOKIE_SECURE,
    )
    logger.info('auth: session issued via Basic auth for username=%r', username[:64])
    return response


@app.get('/api/auth/status')
def api_auth_status():
    authenticated = AUTH_DISABLED or _validate_auth_session()
    result = {
        'authenticated': authenticated,
        'auth_required': not AUTH_DISABLED and _has_auth_credentials_configured(),
    }
    # Only reveal username hint to already-authenticated sessions.
    if authenticated:
        result['username_hint'] = AUTH_USERNAME
    return jsonify(result)


@app.post('/api/auth/login')
def api_auth_login():
    if not _has_auth_credentials_configured():
        return jsonify({'error': 'auth is not configured'}), 500

    payload = request.get_json(silent=True) or {}
    username = str(payload.get('username', '')).strip()
    password = str(payload.get('password', '')).strip()
    if not _validate_login_credentials(username, password):
        # Username and source address only — never the password, and never the
        # session id that a success would create.
        logger.warning(
            'auth: failed login for username=%r from %s', username[:64], request.remote_addr or '-'
        )
        return jsonify({'error': 'invalid credentials'}), 401

    sid, expires_at = _new_auth_session(username)
    logger.info(
        'auth: login succeeded for username=%r from %s', username[:64], request.remote_addr or '-'
    )
    response = make_response(jsonify({'ok': True, 'expires_at': expires_at}))
    response.set_cookie(
        AUTH_SESSION_COOKIE_NAME,
        sid,
        max_age=max(300, AUTH_SESSION_TTL_SECONDS),
        httponly=True,
        samesite='Lax',
        secure=COOKIE_SECURE,
    )
    return response


@app.post('/api/auth/logout')
def api_auth_logout():
    sid = request.cookies.get(AUTH_SESSION_COOKIE_NAME)
    _delete_auth_session(sid)
    response = make_response(jsonify({'ok': True}))
    response.delete_cookie(AUTH_SESSION_COOKIE_NAME)
    return response


def load_spacy_model() -> spacy.language.Language:
    """Load configured spaCy model with safe fallbacks for local/dev startup."""
    candidates = [SPACY_MODEL]
    if SPACY_MODEL != 'de_core_news_sm':
        candidates.append('de_core_news_sm')

    for name in candidates:
        try:
            logger.info('Loading spaCy German model (%s)...', name)
            model = spacy.load(name)
            logger.info('spaCy model loaded.')
            return model
        except OSError:
            logger.warning('spaCy model not available: %s', name)

    logger.warning("Falling back to spaCy blank('de'); grammar hints will be limited.")
    return spacy.blank('de')


nlp = load_spacy_model()


def parse_srt_timecode(value: str) -> float:
    # Format: HH:MM:SS,mmm
    hms, ms = value.split(',')
    h, m, s = hms.split(':')
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_srt(path: Path) -> list[dict]:
    content = path.read_text(encoding='utf-8', errors='ignore')
    blocks = re.split(r'\r?\n\r?\n', content.strip())
    segments = []

    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue

        # block may start with an index line; detect timestamp line robustly
        ts_line_idx = 1 if re.match(r'^\d+$', lines[0]) and len(lines) > 1 else 0
        ts_line = lines[ts_line_idx]
        if '-->' not in ts_line:
            continue

        start_raw, end_raw = [part.strip() for part in ts_line.split('-->', 1)]
        try:
            start = parse_srt_timecode(start_raw)
            end = parse_srt_timecode(end_raw)
        except Exception:
            continue

        text = ' '.join(lines[ts_line_idx + 1 :]).strip()
        if not text:
            continue

        segments.append({'start': start, 'end': end, 'text': text})

    return segments


def episode_title_from_name(stem: str) -> str:
    m = re.match(r'^(\d+)_', stem)
    if m:
        return f'Episode {m.group(1)}'
    return stem


def normalize_word(word: str) -> str:
    return re.sub(r'[^A-Za-zÄÖÜäöüß-]', '', word).strip().lower()


def translate_text_de_to_en(text: str) -> str:
    cleaned = re.sub(r'\s+', ' ', text).strip()
    if not cleaned:
        return ''
    cached = TEXT_TRANSLATION_CACHE.get(cleaned)
    if cached is not None:
        return cached

    url = 'https://translate.googleapis.com/translate_a/single'
    params = {
        'client': 'gtx',
        'sl': 'de',
        'tl': 'en',
        'dt': 't',
        'q': cleaned,
    }

    try:
        resp = requests.get(url, params=params, timeout=6)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return ''

    translated = ''
    if isinstance(data, list) and data and isinstance(data[0], list):
        translated = ''.join(part[0] for part in data[0] if isinstance(part, list) and part)

    translated = translated.strip()
    TEXT_TRANSLATION_CACHE.set(cleaned, translated)
    return translated


def translate_word_de_to_en(word: str) -> str:
    cleaned = normalize_word(word)
    if not cleaned:
        return ''
    return translate_text_de_to_en(cleaned)


def analyze_word(word: str, context: str = '') -> dict:
    """
    Run spaCy once and return all derived info for a word in context.
    spacy.explain() is used for POS, dependency, and entity labels — no hardcoding.
    """
    cache_key = f'analyze_{word.lower()}_{context[:60]}'
    cached = ANALYSIS_CACHE.get(cache_key)
    if cached is not None and isinstance(cached, dict) and 'grammar_hint' in cached:
        return cached

    text = context if context else word
    doc = nlp(text)
    token = next((t for t in doc if t.text.lower() == word.lower()), None)

    empty: dict = {
        'pos': '',
        'pos_tag': '',
        'is_noun': False,
        'article': '',
        'grammar_hint': '',
        'lemma': '',
        'dep': '',
        'ent_type': '',
    }
    if not token:
        ANALYSIS_CACHE.set(cache_key, empty)
        return empty

    # Use raw spaCy POS tag directly (e.g. noun, verb, det, pron)
    pos = token.pos_.lower()

    # ── Morphology: iterate ALL features from morph dict ─────────────────
    morph_dict = token.morph.to_dict()

    # Morph keys to skip — mostly noisy for learners in tooltips
    SKIP_MORPH_KEYS = {'Foreign', 'Abbr', 'Typo'}

    parts = [pos]
    for key, val in morph_dict.items():
        if key in SKIP_MORPH_KEYS:
            continue
        parts.append(str(val).lower())

    grammar_hint = f'({", ".join(parts)})'

    # ── Lemma ─────────────────────────────────────────────────────────────
    lemma = token.lemma_ if token.lemma_ and token.lemma_.lower() != word.lower() else ''

    # ── Dependency: fully dynamic via spacy.explain() ────────────────────
    dep_raw = token.dep_ or ''
    dep = (spacy.explain(dep_raw) or dep_raw).lower() if dep_raw else ''

    # ── Named entity: fully dynamic via spacy.explain() ──────────────────
    ent_raw = token.ent_type_ or ''
    if ent_raw:
        full = spacy.explain(ent_raw) or ent_raw
        # Take only the first clause of spacy.explain() (stops at comma/period)
        ent_type = re.split(r'[,.]', full)[0].strip().lower()
    else:
        ent_type = ''

    # ── Article (NOUN only, from morph gender+case) ───────────────────────
    article = ''
    if token.pos_ == 'NOUN' and 'Gender' in morph_dict:
        article_table = {
            ('Masc', 'Nom'): 'der',
            ('Masc', 'Acc'): 'den',
            ('Masc', 'Dat'): 'dem',
            ('Masc', 'Gen'): 'des',
            ('Fem', 'Nom'): 'die',
            ('Fem', 'Acc'): 'die',
            ('Fem', 'Dat'): 'der',
            ('Fem', 'Gen'): 'der',
            ('Neut', 'Nom'): 'das',
            ('Neut', 'Acc'): 'das',
            ('Neut', 'Dat'): 'dem',
            ('Neut', 'Gen'): 'des',
            ('Plur', 'Nom'): 'die',
            ('Plur', 'Acc'): 'die',
            ('Plur', 'Dat'): 'den',
            ('Plur', 'Gen'): 'der',
        }
        gender = morph_dict.get('Gender', '')
        case = morph_dict.get('Case', '')
        number = morph_dict.get('Number', '')
        g = 'Plur' if number == 'Plur' else gender
        article = article_table.get((g, case), '')

    result = {
        'pos': pos,
        'pos_tag': token.pos_,
        'is_noun': token.pos_ == 'NOUN',
        'article': article,
        'grammar_hint': grammar_hint,
        'lemma': lemma,
        'dep': dep,
        'ent_type': ent_type,
    }
    ANALYSIS_CACHE.set(cache_key, result)
    return result


def build_follow_on_explanation(word: str, context: str = '') -> dict:
    """Return a short explanation and concrete examples for a word."""
    info = analyze_word(word, context)
    pos_tag = info.get('pos_tag', '')
    lemma = info.get('lemma', '') or word

    # Keep this compact and deterministic (no external LLM dependency).
    if pos_tag == 'NOUN':
        article = info.get('article', '')
        head = f'{article} {word}'.strip()
        return {
            'title': f'{head} is a noun',
            'points': [
                f'Dictionary form (lemma): {lemma}',
                f'Current grammar: {info.get("grammar_hint", "")}',
                'Nouns in German are capitalized.',
            ],
            'examples': [
                f'Ich sehe {head}.  ->  I see {word}.',
                f'Das ist {head}.  ->  That is {word}.',
            ],
        }

    if pos_tag in ('VERB', 'AUX'):
        return {
            'title': f'{word} is a verb',
            'points': [
                f'Dictionary form (lemma): {lemma}',
                f'Current grammar: {info.get("grammar_hint", "")}',
                'Verb form changes with tense/person.',
            ],
            'examples': [
                f'Ich {word}.  ->  I {translate_word_de_to_en(word)}.',
                f'Wir {lemma}.  ->  We {translate_word_de_to_en(lemma)}.',
            ],
        }

    if pos_tag == 'DET':
        return {
            'title': f'{word} is an article/determiner',
            'points': [
                f'Current grammar: {info.get("grammar_hint", "")}',
                'Articles mark case, gender, and number.',
            ],
            'examples': [
                'der Hund (nom, masc)',
                'den Hund (acc, masc)',
                'dem Hund (dat, masc)',
            ],
        }

    return {
        'title': f'{word} ({info.get("pos", "").strip()})',
        'points': [
            f'Current grammar: {info.get("grammar_hint", "")}',
            f'Lemma: {lemma}',
        ],
        'examples': [
            f'Context: {context}' if context else f'Word: {word}',
        ],
    }


def transcript_paths(stem: str) -> dict[str, Path]:
    """Transcript file candidates for an episode, in preference order."""
    return {ext: TRANSCRIPTS_DIR / f'{stem}.{ext}' for ext in ('json', 'srt', 'txt')}


def transcript_type_for(stem: str) -> str:
    """Best available transcript format for an episode, or 'none'."""
    return next((ext for ext, p in transcript_paths(stem).items() if p.exists()), 'none')


def build_episode_index() -> list[dict]:
    episodes = []
    for audio_path in sorted(DOWNLOADS_DIR.glob('*.mp3'), key=lambda p: p.name):
        stem = audio_path.stem
        episodes.append(
            {
                'id': stem,
                'title': episode_title_from_name(stem),
                'audio': f'/media/{audio_path.name}',
                'transcript_type': transcript_type_for(stem),
            }
        )

    episodes.sort(key=lambda item: item['id'], reverse=True)
    return episodes


@app.get('/')
def index():
    return send_from_directory(VIEWER_DIR, 'index.html')


@app.get('/api/episodes')
def api_episodes():
    return jsonify(build_episode_index())


@app.get('/api/config')
def api_config():
    result = {
        'version': __version__,
        'cast_receiver_app_id': CAST_RECEIVER_APP_ID,
        'auth_required': not AUTH_DISABLED and _has_auth_credentials_configured(),
    }
    # Only reveal username hint to authenticated sessions.
    if AUTH_DISABLED or _validate_auth_session():
        result['username_hint'] = AUTH_USERNAME
    return jsonify(result)


@app.post('/api/cast/session')
def api_cast_session():
    payload = request.get_json(silent=True) or {}
    raw_id = str(payload.get('episode_id', '')).strip()
    logger.info('cast/session requested — episode_id=%s remote=%s', raw_id, request.remote_addr)

    # Allow the receiver's any-episode session token request.
    if raw_id == CAST_SCOPE_ANY:
        episode_id = CAST_SCOPE_ANY
    else:
        episode_id = _validate_episode_id(raw_id)
    if not episode_id:
        logger.warning('cast/session: invalid episode_id: %s', raw_id)
        return jsonify({'error': 'invalid episode_id'}), 400
    if not CAST_SIGNING_KEY:
        logger.error('cast/session: signing key not configured')
        return jsonify({'error': 'cast token signing key is not configured'}), 500

    token, expires_at = _mint_cast_token(episode_id)
    logger.info('cast/session: token minted for episode=%s expires_at=%d', episode_id, expires_at)
    return jsonify(
        {'token': token, 'expires_at': expires_at, 'token_ttl_seconds': CAST_TOKEN_TTL_SECONDS}
    )


@app.post('/api/cast/validate')
def api_cast_validate():
    payload = request.get_json(silent=True) or {}
    token = str(payload.get('token', '')).strip()
    logger.info(
        'cast/validate requested — has_token=%s remote=%s', bool(token), request.remote_addr
    )
    claims = _verify_cast_token(token)
    if not claims:
        logger.warning('cast/validate: token invalid or expired')
        return jsonify({'valid': False}), 401

    expected_episode = str(payload.get('episode_id', '')).strip()
    if expected_episode and claims.get('ep') != expected_episode:
        logger.warning(
            'cast/validate: episode mismatch expected=%s got=%s', expected_episode, claims.get('ep')
        )
        return jsonify({'valid': False}), 403
    logger.info('cast/validate: token valid for episode=%s', claims.get('ep'))
    return jsonify({'valid': True, 'claims': claims})


@app.get('/api/cast/debug')
def api_cast_debug():
    """Diagnostic endpoint returning cast configuration and runtime state."""
    now = int(time.time())
    with AUTH_SESSIONS_LOCK:
        active_sessions = sum(1 for exp in AUTH_SESSIONS.values() if exp > now)
        total_sessions = len(AUTH_SESSIONS)

    return jsonify(
        {
            'cast': {
                'receiver_app_id': CAST_RECEIVER_APP_ID,
                'signing_key_configured': bool(CAST_SIGNING_KEY),
                'token_ttl_seconds': CAST_TOKEN_TTL_SECONDS,
                'token_required_for_media': CAST_TOKEN_REQUIRED_FOR_MEDIA,
                'custom_namespace': 'urn:x-cast:com.echoai.auth',
            },
            'auth': {
                'disabled': AUTH_DISABLED,
                'username_configured': bool(AUTH_USERNAME),
                'password_configured': bool(AUTH_PASSWORD),
                'session_secret_configured': bool(AUTH_SESSION_SECRET),
                'session_cookie_name': AUTH_SESSION_COOKIE_NAME,
                'session_ttl_seconds': AUTH_SESSION_TTL_SECONDS,
                'active_sessions': active_sessions,
                'total_sessions': total_sessions,
            },
            'paths': {
                'downloads_dir': str(DOWNLOADS_DIR),
                'downloads_exists': DOWNLOADS_DIR.exists(),
                'transcripts_dir': str(TRANSCRIPTS_DIR),
                'transcripts_exists': TRANSCRIPTS_DIR.exists(),
                'viewer_dir': str(VIEWER_DIR),
                'viewer_exists': VIEWER_DIR.exists(),
                'index_html_exists': (VIEWER_DIR / 'index.html').exists(),
            },
            'content': {
                'mp3_count': len(list(DOWNLOADS_DIR.glob('*.mp3')))
                if DOWNLOADS_DIR.exists()
                else 0,
                'json_count': len(list(TRANSCRIPTS_DIR.glob('*.json')))
                if TRANSCRIPTS_DIR.exists()
                else 0,
                'srt_count': len(list(TRANSCRIPTS_DIR.glob('*.srt')))
                if TRANSCRIPTS_DIR.exists()
                else 0,
            },
            'csp_policy': CSP_POLICY,
            'server_time': now,
        }
    )


@app.get('/api/episode/<episode_id>')
def api_episode(episode_id: str):
    safe_id = _validate_episode_id(episode_id)
    if not safe_id:
        return jsonify({'error': 'invalid episode id'}), 400

    audio_path = DOWNLOADS_DIR / f'{safe_id}.mp3'
    if not audio_path.exists():
        return jsonify({'error': 'episode not found'}), 404

    paths = transcript_paths(safe_id)
    json_path, srt_path, txt_path = paths['json'], paths['srt'], paths['txt']

    payload = {
        'id': safe_id,
        'title': episode_title_from_name(safe_id),
        'audio': f'/media/{audio_path.name}',
        'transcript_type': 'none',
        'segments': [],
        'words': [],
        'text': '',
    }

    if json_path.exists():
        try:
            raw_segs = json.loads(json_path.read_text(encoding='utf-8', errors='ignore'))
            if not isinstance(raw_segs, list):
                raise ValueError('transcript json is not a list of segments')
        except (OSError, ValueError) as exc:
            logger.warning('Unreadable transcript json for %s: %s', safe_id, type(exc).__name__)
            raw_segs = []

        clean_segs = []
        flat_words = []
        for seg in raw_segs:
            # Per-item isolation: one malformed segment must not lose the episode.
            try:
                if not isinstance(seg, dict) or 'start' not in seg or 'end' not in seg:
                    continue
                seg_text = str(seg.get('text', '')).strip()
                segment_index = len(clean_segs)
                clean_segs.append(
                    {
                        'start': seg['start'],
                        'end': seg['end'],
                        'text': seg_text,
                        'translation_en': '',
                        'avg_logprob': round(float(seg.get('avg_logprob', 0) or 0), 4),
                        'no_speech_prob': round(float(seg.get('no_speech_prob', 0) or 0), 4),
                    }
                )

                for word_data in seg.get('words') or []:
                    if not isinstance(word_data, dict):
                        continue
                    flat_words.append(
                        {
                            'word': word_data.get('word', ''),
                            'start': word_data.get('start', 0),
                            'end': word_data.get('end', 0),
                            'probability': word_data.get('probability', 1),
                            # Explicit owner. The viewer used to re-derive this by
                            # string-matching 'context' against segment text, which
                            # mis-assigned every word whenever two segments shared
                            # the same text.
                            'segment_index': segment_index,
                            'context': seg_text,
                        }
                    )
            except (TypeError, ValueError) as exc:
                logger.warning('Skipping malformed segment in %s: %s', safe_id, type(exc).__name__)
                continue

        if clean_segs:
            payload['segments'] = clean_segs
            payload['words'] = flat_words
            payload['text'] = '\n'.join(s['text'] for s in clean_segs)
            payload['transcript_type'] = 'json'
            logger.debug(
                'Extracted %d words from %d segments for %s',
                len(flat_words),
                len(raw_segs),
                safe_id,
            )

    # Fall through to srt/txt when the json was missing or unusable.
    if payload['transcript_type'] == 'none' and srt_path.exists():
        payload['transcript_type'] = 'srt'
        segments = parse_srt(srt_path)
        for seg in segments:
            seg['translation_en'] = ''
        payload['segments'] = segments
        payload['text'] = '\n'.join(seg['text'] for seg in segments)

    elif payload['transcript_type'] == 'none' and txt_path.exists():
        payload['transcript_type'] = 'txt'
        payload['text'] = txt_path.read_text(encoding='utf-8', errors='ignore')

    return jsonify(payload)


@app.get('/api/translate-text')
def api_translate_text():
    text = (request.args.get('text') or '').strip()
    if not text:
        return jsonify({'translation': ''})
    if len(text) > TRANSLATE_TEXT_MAX_LEN:
        return jsonify({'error': 'text too long', 'max': TRANSLATE_TEXT_MAX_LEN}), 400

    return jsonify({'translation': translate_text_de_to_en(text)})


@app.get('/api/translate')
def api_translate():
    word = (request.args.get('word') or '').strip()
    context = (request.args.get('context') or '').strip()
    cleaned = normalize_word(word)
    if not cleaned:
        return jsonify({'translation': ''})
    if len(word) > TRANSLATE_WORD_MAX_LEN:
        return jsonify({'error': 'word too long'}), 400

    try:
        info = analyze_word(word, context)

        # Articles always translate as "the"
        if info.get('pos_tag') == 'DET':
            translated = 'the'
        else:
            translated = translate_word_de_to_en(cleaned)

        display = f'{info["article"]} {word}'.strip() if info.get('article') else word

        # Build tooltip lines:
        # Line 1: "der Hund" (display with article if noun)
        # Line 2: English translation
        # Line 3: grammar hint  e.g. (noun, acc, masc, sing)
        # Line 4: lemma if different  e.g. lemma: sprechen
        # Line 5: dependency role  e.g. role: subject
        # Line 6: named entity   e.g. entity: person
        lines = [translated, info['grammar_hint']]
        # Lemma — show only if meaningfully different (e.g. "gesprochen" → "sprechen")
        if info.get('lemma') and info['lemma'].lower() != word.lower():
            lines.append(f'lemma: {info["lemma"]}')
        # Dependency role — skip root/punctuation/determiner which add no learning value
        if info.get('dep') and info['dep'] not in ('root', 'ROOT', 'punctuation', 'determiner'):
            lines.append(f'role: {info["dep"]}')
        if info.get('ent_type'):
            lines.append(f'entity: {info["ent_type"]}')

        return jsonify(
            {
                'display': display,
                'translation': '\n'.join(lines),
            }
        )
    except Exception:
        return jsonify({'display': word, 'translation': ''})


@app.get('/api/explain')
def api_explain():
    word = (request.args.get('word') or '').strip()
    context = (request.args.get('context') or '').strip()
    if not normalize_word(word):
        return jsonify({'title': '', 'points': [], 'examples': []})
    if len(word) > TRANSLATE_WORD_MAX_LEN:
        return jsonify({'error': 'word too long'}), 400

    try:
        payload = build_follow_on_explanation(word, context)
        return jsonify(payload)
    except Exception:
        return jsonify({'title': word, 'points': [], 'examples': []})


@app.get('/media/<path:filename>')
def media(filename: str):
    if CAST_TOKEN_REQUIRED_FOR_MEDIA and not _validate_auth_session():
        token = (request.args.get('rt') or '').strip()
        claims = _verify_cast_token(token)
        if not claims:
            return jsonify({'error': 'invalid cast token'}), 401
        # 'ep' is the token scope: a specific episode, or CAST_SCOPE_ANY for the
        # receiver's own session token (the receiver switches episodes on-device
        # and cannot mint a per-episode token of its own).
        scope = claims.get('ep')
        if scope != CAST_SCOPE_ANY and scope != Path(filename).stem:
            return jsonify({'error': 'cast token episode mismatch'}), 403
    return send_from_directory(DOWNLOADS_DIR, filename, as_attachment=False)


@app.get('/static/<path:filename>')
def static_files(filename: str):
    return send_from_directory(VIEWER_DIR, filename)


# ── Log viewing ──────────────────────────────────────────────────────────────

# OK is a client-only level; everything else maps to its logging equivalent.
_CLIENT_LEVEL_TO_LOGGING = {
    'DEBUG': logging.DEBUG,
    'INFO': logging.INFO,
    'OK': logging.INFO,
    'WARN': logging.WARNING,
    'ERROR': logging.ERROR,
}

# Fixed-window flood guard for client log ingestion. Deliberately global rather
# than per-IP: a per-IP dict is unbounded state keyed by attacker input, which
# is the very thing this codebase forbids.
_client_log_window_start = 0.0
_client_log_window_count = 0
_CLIENT_LOG_RATE_LOCK = threading.Lock()


def _client_log_rate_limit_ok() -> bool:
    """Consume one slot from the current window. False once the ceiling is hit."""
    global _client_log_window_start, _client_log_window_count
    now = time.monotonic()
    with _CLIENT_LOG_RATE_LOCK:
        if now - _client_log_window_start >= CLIENT_LOG_RATE_WINDOW_SECONDS:
            _client_log_window_start = now
            _client_log_window_count = 0
        if _client_log_window_count >= CLIENT_LOG_RATE_MAX_ENTRIES:
            return False
        _client_log_window_count += 1
        return True


def _read_log_tail(max_bytes: int = LOG_TAIL_MAX_BYTES) -> list[str]:
    """Return the last `max_bytes` of the log file as lines, oldest first.

    Reads only the tail so a rotated-but-large file can never blow the Pi's
    512 MB budget. The first line is dropped when the file was truncated, as
    it is almost certainly a partial record.
    """
    if not LOG_FILE:
        return []
    path = Path(LOG_FILE)
    try:
        size = path.stat().st_size
        with path.open('rb') as handle:
            if size > max_bytes:
                handle.seek(size - max_bytes)
                handle.readline()  # discard the partial first line
            raw = handle.read()
    except OSError:
        logger.exception('could not read log file %s', LOG_FILE)
        return []
    return raw.decode('utf-8', 'replace').splitlines()


def parse_log_lines(lines: list[str]) -> list[dict[str, str]]:
    """Turn raw log lines into records, folding continuation lines into the previous one.

    A traceback is many physical lines but one logical record — attaching it to
    its parent keeps stack traces readable and filterable in the viewer.
    """
    records: list[dict[str, str]] = []
    for line in lines:
        match = _LOG_LINE_RE.match(line)
        if match:
            records.append(match.groupdict())
        elif records:
            records[-1]['message'] += '\n' + line
        # A continuation with no parent (start of a truncated file) is dropped.
    return records


def filter_log_records(
    records: list[dict[str, str]],
    levels: set[str] | None = None,
    search: str = '',
    source: str = '',
) -> list[dict[str, str]]:
    """Apply the viewer's filters. All are case-insensitive and optional."""
    needle = search.strip().lower()
    source = source.strip().lower()
    result = []
    for record in records:
        if levels and record['level'] not in levels:
            continue
        if source and source not in record['name'].lower():
            continue
        if needle and needle not in record['message'].lower():
            continue
        result.append(record)
    return result


@app.get('/logs')
def logs_page():
    """Serve the log viewer shell.

    Deliberately public, exactly like `/`: this file contains no log data. Every
    byte of actual log content comes from /api/logs, which is in
    SESSION_ONLY_PATHS and so needs a real logged-in session.
    """
    return send_from_directory(VIEWER_DIR, 'logs.html')


@app.get('/api/logs')
def api_logs():
    """Return filtered log records, newest last. Session-only — see SESSION_ONLY_PATHS."""
    limit = max(1, min(env_int_arg('limit', LOG_API_DEFAULT_LINES), LOG_API_MAX_LINES))
    search = (request.args.get('search') or '')[:200]
    source = (request.args.get('source') or '')[:100]
    raw_levels = (request.args.get('levels') or '').strip().upper()
    levels = {part for part in raw_levels.split(',') if part} or None

    records = filter_log_records(parse_log_lines(_read_log_tail()), levels, search, source)
    total = len(records)
    return jsonify(
        {
            'records': records[-limit:],
            'total': total,
            'returned': min(total, limit),
            'log_file': LOG_FILE,
            'level': LOG_LEVEL,
        }
    )


@app.post('/api/logs/client')
def api_logs_client():
    """Ingest browser / Chromecast logs so TV-side failures are visible on the Pi.

    Reachable with a cast token on purpose: the receiver runs on a Chromecast
    with no cookies and no DevTools, and its logs are the only window into Cast
    playback bugs.

    Everything in the body is attacker-controlled, so it is treated as hostile:
    the body size is capped by MAX_CONTENT_LENGTH, the batch is truncated, each
    message is length-clamped and stripped of every character that could forge a
    new log record, the level is whitelisted, and a rate limit stops a flood
    from rotating real evidence out of the file.
    """
    if not _client_log_rate_limit_ok():
        # 429 rather than a silent drop, so a misbehaving client can back off.
        return jsonify({'error': 'log rate limit exceeded'}), 429

    payload = request.get_json(silent=True) or {}
    entries = payload.get('entries')
    if not isinstance(entries, list):
        return jsonify({'error': 'entries must be a list'}), 400

    source = sanitize_log_text(str(payload.get('source', 'client'))[:20]) or 'client'
    accepted = 0
    for entry in entries[:CLIENT_LOG_MAX_ENTRIES]:
        if not isinstance(entry, dict):
            continue
        level = str(entry.get('level', 'INFO')).strip().upper()
        if level not in CLIENT_LOG_LEVELS:
            level = 'INFO'
        message = sanitize_log_text(str(entry.get('msg', ''))[:CLIENT_LOG_MAX_MSG_LEN]).strip()
        if not message:
            continue
        # OK is a client-only level with no logging equivalent; it maps to INFO.
        client_logger.log(
            _CLIENT_LEVEL_TO_LOGGING.get(level, logging.INFO), '[%s] %s', source, message
        )
        accepted += 1
    return jsonify({'accepted': accepted})


def env_int_arg(name: str, default: int) -> int:
    """Read an integer query parameter, falling back to the default on anything unusable."""
    try:
        return int(request.args.get(name, ''))
    except TypeError, ValueError:
        return default


def _validate_secrets() -> None:
    """Warn at startup if secrets are weak or reused.

    Thresholds mirror docs/RASPBERRY_PI_DEPLOYMENT.md. The three secrets default
    to each other when unset, so the reuse checks are what catch a half-filled
    .env in production.
    """
    issues = []
    if not AUTH_DISABLED and not _has_auth_credentials_configured():
        issues.append('auth is enabled but username/password/session secret are not all set')
    if AUTH_PASSWORD and len(AUTH_PASSWORD) < 16:
        issues.append('AUTH_PASSWORD is shorter than 16 characters — use a stronger password')
    if AUTH_SESSION_SECRET and AUTH_SESSION_SECRET == AUTH_PASSWORD:
        issues.append('AUTH_SESSION_SECRET equals AUTH_PASSWORD — use an independent secret')
    if CAST_SIGNING_KEY and CAST_SIGNING_KEY == AUTH_PASSWORD:
        issues.append('CAST_SIGNING_KEY equals AUTH_PASSWORD — use an independent signing key')
    if AUTH_SESSION_SECRET and AUTH_SESSION_SECRET == CAST_SIGNING_KEY:
        issues.append('AUTH_SESSION_SECRET equals CAST_SIGNING_KEY — use independent secrets')
    if AUTH_SESSION_SECRET and len(AUTH_SESSION_SECRET) < 64:
        issues.append('AUTH_SESSION_SECRET is shorter than 64 characters')
    if CAST_SIGNING_KEY and len(CAST_SIGNING_KEY) < 64:
        issues.append('CAST_SIGNING_KEY is shorter than 64 characters')
    for issue in issues:
        logger.warning('SECURITY: %s', issue)


def main() -> None:
    parser = argparse.ArgumentParser(description='Run local transcript web viewer')
    parser.add_argument('--host', default=os.getenv('TRANSCRIPT_VIEWER_HOST', '0.0.0.0'))
    parser.add_argument('--port', type=int, default=env_int('TRANSCRIPT_VIEWER_PORT', 5000))
    args = parser.parse_args()

    # Without this the module's logger.info/warning calls are dropped, so the
    # SECURITY: warnings the deployment guide tells you to check never appear.
    _configure_logging()

    _validate_secrets()

    VIEWER_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

    logger.info(
        'echoai %s starting — downloads=%s transcripts=%s auth_disabled=%s cast_token_required=%s',
        __version__,
        DOWNLOADS_DIR,
        TRANSCRIPTS_DIR,
        AUTH_DISABLED,
        CAST_TOKEN_REQUIRED_FOR_MEDIA,
    )
    logger.info('Viewer: http://%s:%d', args.host, args.port)
    logger.info('Logs:   http://%s:%d/logs', args.host, args.port)
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == '__main__':
    main()
