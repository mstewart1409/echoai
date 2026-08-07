"""Tests for the request-level auth gate and media token scoping.

Auth is force-enabled here by patching the module globals, so these exercise the
production configuration rather than the AUTH_DISABLED dev path.
"""

import os

import pytest

os.environ.setdefault('TRANSCRIPT_VIEWER_AUTH_DISABLED', '1')
os.environ.setdefault('TRANSCRIPT_VIEWER_CAST_SIGNING_KEY', 'k' * 64)

from echoai import transcript_viewer as tv  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    """Flask test client with auth enforced and cast media tokens required."""
    monkeypatch.setattr(tv, 'AUTH_DISABLED', False)
    monkeypatch.setattr(tv, 'CAST_TOKEN_REQUIRED_FOR_MEDIA', True)
    monkeypatch.setattr(tv, 'CAST_SIGNING_KEY', 'k' * 64)
    tv.app.config['TESTING'] = True
    return tv.app.test_client()


def test_unauthenticated_request_is_rejected(client) -> None:
    assert client.get('/api/episodes').status_code == 401


def test_cast_token_grants_content_access(client) -> None:
    token, _ = tv._mint_cast_token('123_ep')
    assert client.get(f'/api/episodes?rt={token}').status_code == 200


def test_cast_token_cannot_mint_another_token(client) -> None:
    """Otherwise the short token TTL would be meaningless - endless self-renewal."""
    token, _ = tv._mint_cast_token('123_ep')
    resp = client.post('/api/cast/session', json={'episode_id': '123_ep'}, query_string={'rt': token})
    assert resp.status_code == 401


def test_cast_token_cannot_read_diagnostics(client) -> None:
    token, _ = tv._mint_cast_token('123_ep')
    assert client.get(f'/api/cast/debug?rt={token}').status_code == 401


def test_media_rejects_token_for_a_different_episode(client) -> None:
    token, _ = tv._mint_cast_token('123_ep')
    assert client.get(f'/media/999_other.mp3?rt={token}').status_code == 403


def test_media_rejects_missing_token(client) -> None:
    assert client.get('/media/123_ep.mp3').status_code == 401


def test_media_accepts_receiver_scope_token(client, monkeypatch, tmp_path) -> None:
    """The receiver's any-episode token must work for episodes it picks on-device."""
    (tmp_path / '123_ep.mp3').write_bytes(b'id3')
    monkeypatch.setattr(tv, 'DOWNLOADS_DIR', tmp_path)
    token, _ = tv._mint_cast_token(tv.CAST_SCOPE_ANY)
    assert client.get(f'/media/123_ep.mp3?rt={token}').status_code == 200


def test_csp_host_sources_are_scheme_less() -> None:
    """Pinning https:// would block the protocol-relative Cast SDK over http://."""
    assert 'https://www.gstatic.com' not in tv.CSP_POLICY
    assert 'www.gstatic.com' in tv.CSP_POLICY
    # The CAF receiver reaches the local Cast platform over this socket.
    assert 'ws://localhost:*' in tv.CSP_POLICY
