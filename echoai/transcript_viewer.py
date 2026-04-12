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

import requests
import spacy
from pathlib import Path
from dotenv import load_dotenv

from flask import Flask, jsonify, make_response, request, send_from_directory

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE_DIR = PROJECT_ROOT
load_dotenv(PROJECT_ROOT / '.env')

BASE_DIR = Path(os.getenv('TRANSCRIPT_VIEWER_BASE_DIR', str(DEFAULT_BASE_DIR))).resolve()
DOWNLOADS_DIR = Path(
    os.getenv('TRANSCRIPT_VIEWER_DOWNLOADS_DIR', str(BASE_DIR / 'downloads'))
).resolve()
TRANSCRIPTS_DIR = Path(
    os.getenv('TRANSCRIPT_VIEWER_TRANSCRIPTS_DIR', str(BASE_DIR / 'transcripts'))
).resolve()
VIEWER_DIR = Path(
    os.getenv('TRANSCRIPT_VIEWER_STATIC_DIR', str(BASE_DIR / 'echoai' / 'viewer'))
).resolve()
SPACY_MODEL = os.getenv('TRANSCRIPT_VIEWER_SPACY_MODEL', 'de_core_news_sm')
CAST_RECEIVER_APP_ID = os.getenv('TRANSCRIPT_VIEWER_CAST_RECEIVER_APP_ID', 'CC1AD845')
AUTH_DISABLED = os.getenv('TRANSCRIPT_VIEWER_AUTH_DISABLED', '').strip().lower() in ('1', 'true')
AUTH_USERNAME = os.getenv(
    'TRANSCRIPT_VIEWER_AUTH_USERNAME', os.getenv('TRANSCRIPT_VIEWER_CAST_BASIC_AUTH_USERNAME', '')
).strip()
AUTH_PASSWORD = os.getenv(
    'TRANSCRIPT_VIEWER_AUTH_PASSWORD', os.getenv('TRANSCRIPT_VIEWER_CAST_BASIC_AUTH_PASSWORD', '')
).strip()
CAST_SIGNING_KEY = os.getenv('TRANSCRIPT_VIEWER_CAST_SIGNING_KEY', AUTH_PASSWORD).strip()
AUTH_SESSION_SECRET = os.getenv('TRANSCRIPT_VIEWER_AUTH_SESSION_SECRET', CAST_SIGNING_KEY).strip()
AUTH_SESSION_COOKIE_NAME = (
    os.getenv('TRANSCRIPT_VIEWER_AUTH_SESSION_COOKIE_NAME', 'tv_session').strip() or 'tv_session'
)
COOKIE_SECURE = os.getenv('TRANSCRIPT_VIEWER_COOKIE_SECURE', '1').strip().lower() not in (
    '0',
    'false',
)
try:
    CAST_TOKEN_TTL_SECONDS = int(os.getenv('TRANSCRIPT_VIEWER_CAST_TOKEN_TTL_SECONDS', '300'))
except ValueError:
    CAST_TOKEN_TTL_SECONDS = 300
try:
    AUTH_SESSION_TTL_SECONDS = int(os.getenv('TRANSCRIPT_VIEWER_AUTH_SESSION_TTL_SECONDS', '86400'))
except ValueError:
    AUTH_SESSION_TTL_SECONDS = 86400
CAST_TOKEN_REQUIRED_FOR_MEDIA = (
    os.getenv('TRANSCRIPT_VIEWER_CAST_TOKEN_REQUIRED_FOR_MEDIA', '0') == '1'
)

# Bounded cache sizes — prevent unbounded memory growth.
CACHE_MAX_SIZE = int(os.getenv('TRANSCRIPT_VIEWER_CACHE_MAX_SIZE', '10000'))
AUTH_SESSIONS_MAX = int(os.getenv('TRANSCRIPT_VIEWER_AUTH_SESSIONS_MAX', '1000'))

# Maximum input lengths for translation/analysis endpoints.
TRANSLATE_TEXT_MAX_LEN = 500
TRANSLATE_WORD_MAX_LEN = 80

# Regex for safe episode IDs — letters, digits, hyphens, underscores only.
_SAFE_EPISODE_ID_RE = re.compile(r'^[A-Za-z0-9_-]+$')

logger = logging.getLogger(__name__)


def _validate_episode_id(episode_id: str) -> str | None:
    """Return sanitised episode_id or None if invalid."""
    episode_id = episode_id.strip()
    if not episode_id or not _SAFE_EPISODE_ID_RE.fullmatch(episode_id):
        return None
    return episode_id


def _fallback_to_local_dir(
    configured: Path,
    local_default: Path,
    label: str,
    required_file: str | None = None,
) -> Path:
    """Use local project directory when container-only path from .env is missing."""
    configured_ok = configured.exists()
    if configured_ok and required_file:
        configured_ok = (configured / required_file).exists()

    if configured_ok:
        return configured

    local_ok = local_default.exists()
    if local_ok and required_file:
        local_ok = (local_default / required_file).exists()

    if configured != local_default and local_ok:
        logger.warning('%s path %s not found; falling back to %s', label, configured, local_default)
        return local_default
    return configured


def _prefer_local_when_configured_empty(
    configured: Path,
    local_default: Path,
    pattern: str,
    label: str,
) -> Path:
    """Use local project directory when configured directory exists but has no matching files."""
    if configured == local_default:
        return configured

    configured_has_files = any(configured.glob(pattern)) if configured.exists() else False
    local_has_files = any(local_default.glob(pattern)) if local_default.exists() else False

    if not configured_has_files and local_has_files:
        logger.warning('%s path %s is empty; falling back to %s', label, configured, local_default)
        return local_default
    return configured


DOWNLOADS_DIR = _fallback_to_local_dir(DOWNLOADS_DIR, DEFAULT_BASE_DIR / 'downloads', 'Downloads')
TRANSCRIPTS_DIR = _fallback_to_local_dir(
    TRANSCRIPTS_DIR, DEFAULT_BASE_DIR / 'transcripts', 'Transcripts'
)
VIEWER_DIR = _fallback_to_local_dir(
    VIEWER_DIR,
    DEFAULT_BASE_DIR / 'echoai' / 'viewer',
    'Viewer static',
    required_file='index.html',
)

DOWNLOADS_DIR = _prefer_local_when_configured_empty(
    DOWNLOADS_DIR,
    DEFAULT_BASE_DIR / 'downloads',
    '*.mp3',
    'Downloads',
)
TRANSCRIPTS_DIR = _prefer_local_when_configured_empty(
    TRANSCRIPTS_DIR,
    DEFAULT_BASE_DIR / 'transcripts',
    '*.*',
    'Transcripts',
)

app = Flask(__name__, static_folder=str(VIEWER_DIR), static_url_path='/static')

CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' "
    'https://www.gstatic.com https://*.gstatic.com https://ajax.googleapis.com '
    'https://static.cloudflareinsights.com; '
    "style-src 'self' 'unsafe-inline'; "
    "connect-src 'self' ws://localhost:* wss://localhost:* "
    'https://translate.googleapis.com '
    'https://*.google.com https://*.googleapis.com https://*.gstatic.com '
    'https://*.cloudflareinsights.com; '
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

    def __contains__(self, key: str) -> bool:
        with self._lock:
            return key in self._data

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


TEXT_TRANSLATION_CACHE: BoundedCache = BoundedCache(CACHE_MAX_SIZE)
ANALYSIS_CACHE: BoundedCache = BoundedCache(CACHE_MAX_SIZE)
AUTH_SESSIONS: dict[str, int] = {}
AUTH_SESSIONS_LOCK = threading.Lock()


def _is_cast_basic_auth_enabled() -> bool:
    return bool(AUTH_USERNAME and AUTH_PASSWORD)


def _has_auth_credentials_configured() -> bool:
    return bool(AUTH_USERNAME and AUTH_PASSWORD and AUTH_SESSION_SECRET)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _b64url_decode(raw: str) -> bytes:
    padding = '=' * (-len(raw) % 4)
    return base64.urlsafe_b64decode((raw + padding).encode('ascii'))


def _decode_basic_auth(auth_header: str | None) -> tuple[str, str] | None:
    if not auth_header or not auth_header.startswith('Basic '):
        return None
    token = auth_header[6:].strip()
    if not token:
        return None
    try:
        decoded = base64.b64decode(token).decode('utf-8')
    except (binascii.Error, UnicodeDecodeError):
        return None
    if ':' not in decoded:
        return None
    username, password = decoded.split(':', 1)
    return username, password


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
    except (ValueError, binascii.Error):
        return None
    expected_sig = hmac.new(
        CAST_SIGNING_KEY.encode('utf-8'), payload_b64.encode('ascii'), hashlib.sha256
    ).digest()
    if not hmac.compare_digest(provided_sig, expected_sig):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_b64).decode('utf-8'))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
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
def require_authentication():
    if AUTH_DISABLED:
        return None

    # Public entry points for loading the app shell and creating sessions.
    if request.path == '/' or request.path.startswith('/static/'):
        return None

    if request.path in ('/api/auth/status', '/api/auth/login'):
        return None

    if _validate_auth_session():
        return None

    token_claims = _verify_cast_token(_extract_cast_token_from_request())
    if token_claims is not None:
        return None

    return _auth_required_response()


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
        return jsonify({'error': 'invalid credentials'}), 401

    sid, expires_at = _new_auth_session(username)
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


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


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
        resp = requests.get(url, params=params, timeout=12)
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


def build_episode_index() -> list[dict]:
    episodes = []
    for audio_path in sorted(DOWNLOADS_DIR.glob('*.mp3'), key=lambda p: p.name):
        stem = audio_path.stem
        json_path = TRANSCRIPTS_DIR / f'{stem}.json'
        srt_path = TRANSCRIPTS_DIR / f'{stem}.srt'
        txt_path = TRANSCRIPTS_DIR / f'{stem}.txt'

        transcript_type = 'none'
        if json_path.exists():
            transcript_type = 'json'
        elif srt_path.exists():
            transcript_type = 'srt'
        elif txt_path.exists():
            transcript_type = 'txt'

        episodes.append(
            {
                'id': stem,
                'title': episode_title_from_name(stem),
                'audio': f'/media/{audio_path.name}',
                'transcript_type': transcript_type,
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
        'cast_receiver_app_id': CAST_RECEIVER_APP_ID,
        'auth_required': _is_cast_basic_auth_enabled(),
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

    # Allow the special _auth token request.
    if raw_id == '_auth':
        episode_id = '_auth'
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
    return jsonify({'token': token, 'expires_at': expires_at})


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
    logger.info('cast/validate: token valid — claims=%s', claims)
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

    json_path = TRANSCRIPTS_DIR / f'{safe_id}.json'
    srt_path = TRANSCRIPTS_DIR / f'{safe_id}.srt'
    txt_path = TRANSCRIPTS_DIR / f'{safe_id}.txt'

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
        raw_segs = json.loads(json_path.read_text(encoding='utf-8', errors='ignore'))

        clean_segs = []
        flat_words = []
        for seg in raw_segs:
            seg_text = seg.get('text', '').strip()
            clean_seg = {
                'start': seg['start'],
                'end': seg['end'],
                'text': seg_text,
                'translation_en': '',
                'avg_logprob': round(seg.get('avg_logprob', 0), 4),
                'no_speech_prob': round(seg.get('no_speech_prob', 0), 4),
            }

            clean_segs.append(clean_seg)

            words_in_seg = seg.get('words', [])
            for word_data in words_in_seg:
                flat_words.append(
                    {
                        'word': word_data.get('word', ''),
                        'start': word_data.get('start', 0),
                        'end': word_data.get('end', 0),
                        'probability': word_data.get('probability', 1),
                        'context': seg_text,
                    }
                )

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

    elif srt_path.exists():
        payload['transcript_type'] = 'srt'
        segments = parse_srt(srt_path)
        for seg in segments:
            seg['translation_en'] = ''
        payload['segments'] = segments
        payload['text'] = '\n'.join(seg['text'] for seg in segments)

    elif txt_path.exists():
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
        if claims.get('ep') != Path(filename).stem:
            return jsonify({'error': 'cast token episode mismatch'}), 403
    return send_from_directory(DOWNLOADS_DIR, filename, as_attachment=False)


@app.get('/static/<path:filename>')
def static_files(filename: str):
    return send_from_directory(VIEWER_DIR, filename)


def _validate_secrets() -> None:
    """Warn at startup if secrets are weak or reused."""
    issues = []
    if AUTH_PASSWORD and len(AUTH_PASSWORD) < 12:
        issues.append('AUTH_PASSWORD is shorter than 12 characters — use a stronger password')
    if AUTH_SESSION_SECRET and AUTH_SESSION_SECRET == AUTH_PASSWORD:
        issues.append('AUTH_SESSION_SECRET equals AUTH_PASSWORD — use an independent secret')
    if CAST_SIGNING_KEY and CAST_SIGNING_KEY == AUTH_PASSWORD:
        issues.append('CAST_SIGNING_KEY equals AUTH_PASSWORD — use an independent signing key')
    if AUTH_SESSION_SECRET and len(AUTH_SESSION_SECRET) < 32:
        issues.append('AUTH_SESSION_SECRET is shorter than 32 characters')
    for issue in issues:
        logger.warning('SECURITY: %s', issue)


def main() -> None:
    parser = argparse.ArgumentParser(description='Run local transcript web viewer')
    parser.add_argument('--host', default=os.getenv('TRANSCRIPT_VIEWER_HOST', '0.0.0.0'))
    parser.add_argument('--port', type=int, default=env_int('TRANSCRIPT_VIEWER_PORT', 8765))
    args = parser.parse_args()

    _validate_secrets()

    VIEWER_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

    logger.info('Viewer: http://%s:%d', args.host, args.port)
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == '__main__':
    main()
