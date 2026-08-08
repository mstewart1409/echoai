"""Tests for the security-critical and parsing logic in the transcript viewer.

No network calls and no spaCy model download: the module is imported with auth
disabled and a blank-model fallback, so `spacy.load` fails over to `spacy.blank`.
"""

import os
import time

os.environ.setdefault('TRANSCRIPT_VIEWER_AUTH_DISABLED', '1')
os.environ.setdefault('TRANSCRIPT_VIEWER_CAST_SIGNING_KEY', 'k' * 64)

from echoai import transcript_viewer as tv  # noqa: E402


# ── Episode id validation (path traversal is the top risk here) ──────────────


def test_validate_episode_id_accepts_expected_names() -> None:
    assert tv._validate_episode_id('123_easy_german') == '123_easy_german'
    assert tv._validate_episode_id('  abc-123  ') == 'abc-123'


def test_validate_episode_id_rejects_traversal_and_separators() -> None:
    for bad in ('../secret', 'a/b', 'a\\b', 'a.mp3', '', '   ', 'a b', 'ép'):
        assert tv._validate_episode_id(bad) is None, bad


# ── Cast tokens ──────────────────────────────────────────────────────────────


def test_cast_token_roundtrip() -> None:
    token, expires_at = tv._mint_cast_token('123_ep')
    claims = tv._verify_cast_token(token)
    assert claims is not None
    assert claims['ep'] == '123_ep'
    assert claims['exp'] == expires_at


def test_cast_token_rejects_tampered_payload() -> None:
    token, _ = tv._mint_cast_token('123_ep')
    payload_b64, sig = token.split('.', 1)
    forged = tv._b64url_encode(b'{"ep":"other","exp":9999999999,"nonce":"00"}')
    assert tv._verify_cast_token(f'{forged}.{sig}') is None


def test_cast_token_rejects_tampered_signature() -> None:
    token, _ = tv._mint_cast_token('123_ep')
    payload_b64, sig = token.split('.', 1)
    flipped = ('A' if sig[0] != 'A' else 'B') + sig[1:]
    assert tv._verify_cast_token(f'{payload_b64}.{flipped}') is None


def test_cast_token_rejects_expired(monkeypatch) -> None:
    token, _ = tv._mint_cast_token('123_ep')
    # Derived from the configured TTL, not a fixed offset: this test silently
    # stopped testing anything when CAST_TOKEN_TTL_SECONDS was raised to 10800
    # and the hardcoded +10_000 landed inside the validity window.
    future = time.time() + tv.CAST_TOKEN_TTL_SECONDS + 60
    monkeypatch.setattr(tv.time, 'time', lambda: future)
    assert tv._verify_cast_token(token) is None


def test_cast_token_rejects_malformed() -> None:
    for bad in ('', 'nodot', 'a.b', '.', 'a.!!!'):
        assert tv._verify_cast_token(bad) is None, bad


# ── Auth sessions ────────────────────────────────────────────────────────────


def test_session_reaping_removes_only_expired() -> None:
    now = int(time.time())
    with tv.AUTH_SESSIONS_LOCK:
        tv.AUTH_SESSIONS.clear()
        tv.AUTH_SESSIONS['live'] = now + 600
        tv.AUTH_SESSIONS['dead'] = now - 1
        removed = tv._reap_expired_sessions_locked(now)
        assert removed == 1
        assert 'live' in tv.AUTH_SESSIONS
        assert 'dead' not in tv.AUTH_SESSIONS
        tv.AUTH_SESSIONS.clear()


def test_session_count_is_bounded(monkeypatch) -> None:
    monkeypatch.setattr(tv, 'AUTH_SESSIONS_MAX', 3)
    with tv.AUTH_SESSIONS_LOCK:
        tv.AUTH_SESSIONS.clear()
    for _ in range(10):
        tv._new_auth_session('user')
    assert len(tv.AUTH_SESSIONS) <= 3
    with tv.AUTH_SESSIONS_LOCK:
        tv.AUTH_SESSIONS.clear()


# ── SRT parsing ──────────────────────────────────────────────────────────────


def test_parse_srt_timecode() -> None:
    assert tv.parse_srt_timecode('00:00:01,500') == 1.5
    assert tv.parse_srt_timecode('01:02:03,004') == 3723.004


def test_parse_srt_skips_malformed_blocks(tmp_path) -> None:
    srt = tmp_path / 'ep.srt'
    srt.write_text(
        '1\n00:00:00,000 --> 00:00:02,000\nHallo Welt\n'
        '\n'
        '2\nNOT A TIMESTAMP\nignored\n'
        '\n'
        '3\n00:00:02,000 --> 00:00:04,000\nWie geht es dir\n'
        '\n'
        '4\n00:00:bad,000 --> 00:00:05,000\nalso ignored\n',
        encoding='utf-8',
    )
    segments = tv.parse_srt(srt)
    assert [s['text'] for s in segments] == ['Hallo Welt', 'Wie geht es dir']
    assert segments[0]['start'] == 0.0
    assert segments[0]['end'] == 2.0


# ── Bounded cache ────────────────────────────────────────────────────────────


def test_bounded_cache_evicts_least_recently_used() -> None:
    cache = tv.BoundedCache(max_size=2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')  # 'a' becomes most recent, so 'b' should go first
    cache.set('c', 3)
    assert len(cache) == 2
    assert cache.get('b') is None
    assert cache.get('a') == 1
    assert cache.get('c') == 3


# ── Episode titles ───────────────────────────────────────────────────────────


def test_episode_title_from_name() -> None:
    assert tv.episode_title_from_name('123_easy_german') == 'Episode 123'
    assert tv.episode_title_from_name('bonus_clip') == 'bonus_clip'
