"""Tests for the HTTP Basic gate on page shells.

The point of the gate is that no markup renders for an unauthenticated visitor.
The hard constraint is that it must not lock out the Chromecast, which fetches
the shell with no cookies and no way to answer a Basic challenge.
"""

import base64
import os

import pytest

os.environ.setdefault('TRANSCRIPT_VIEWER_AUTH_DISABLED', '1')
os.environ.setdefault('TRANSCRIPT_VIEWER_CAST_SIGNING_KEY', 'k' * 64)

from echoai import transcript_viewer as tv  # noqa: E402

USERNAME = 'alice'
PASSWORD = 'correct-horse-battery-staple'


def basic(username: str = USERNAME, password: str = PASSWORD) -> dict[str, str]:
    raw = base64.b64encode(f'{username}:{password}'.encode()).decode('ascii')
    return {'Authorization': f'Basic {raw}'}


@pytest.fixture
def client(monkeypatch, tmp_path):
    """Auth enforced with real credentials, as in production."""
    monkeypatch.setattr(tv, 'AUTH_DISABLED', False)
    monkeypatch.setattr(tv, 'AUTH_USERNAME', USERNAME)
    monkeypatch.setattr(tv, 'AUTH_PASSWORD', PASSWORD)
    monkeypatch.setattr(tv, 'AUTH_SESSION_SECRET', 's' * 64)
    monkeypatch.setattr(tv, 'CAST_SIGNING_KEY', 'k' * 64)
    # Serve real files so a 200 proves the shell was actually returned.
    (tmp_path / 'index.html').write_text('<html>viewer</html>', encoding='utf-8')
    (tmp_path / 'logs.html').write_text('<html>logs</html>', encoding='utf-8')
    monkeypatch.setattr(tv, 'VIEWER_DIR', tmp_path)
    tv.app.config['TESTING'] = True
    return tv.app.test_client()


# ── The gate ─────────────────────────────────────────────────────────────────


def test_root_challenges_an_anonymous_visitor(client) -> None:
    resp = client.get('/')
    assert resp.status_code == 401
    assert resp.headers['WWW-Authenticate'].startswith('Basic ')


def test_root_does_not_leak_markup_when_challenged(client) -> None:
    """The whole point: nothing renders before sign-in."""
    assert b'viewer' not in client.get('/').data


def test_root_serves_the_shell_with_valid_basic_credentials(client) -> None:
    resp = client.get('/', headers=basic())
    assert resp.status_code == 200
    assert b'viewer' in resp.data


def test_root_rejects_a_wrong_password(client) -> None:
    assert client.get('/', headers=basic(password='wrong')).status_code == 401


def test_root_rejects_a_wrong_username(client) -> None:
    assert client.get('/', headers=basic(username='mallory')).status_code == 401


def test_logs_page_is_gated_too(client) -> None:
    assert client.get('/logs').status_code == 401
    assert client.get('/logs', headers=basic()).status_code == 200


def test_receiver_flag_does_not_unlock_the_logs_page(client) -> None:
    """The exemption is for the viewer shell only — the Chromecast never loads
    /logs, so `?mode=receiver` must not be a way past the gate."""
    assert client.get('/logs?mode=receiver').status_code == 401
    assert client.get('/logs?receiver=1').status_code == 401


@pytest.mark.parametrize(
    'header',
    ['', 'Basic ', 'Basic !!!notbase64!!!', 'Bearer abc', 'Basic ' + base64.b64encode(b'nocolon').decode()],
)
def test_malformed_basic_headers_are_rejected_without_error(client, header: str) -> None:
    assert client.get('/', headers={'Authorization': header}).status_code == 401


# ── Chromecast must keep working ─────────────────────────────────────────────


def test_receiver_shell_is_not_challenged(client) -> None:
    """A TV cannot answer a Basic dialog — gating it would break casting entirely."""
    assert client.get('/?mode=receiver').status_code == 200
    assert client.get('/?receiver=1').status_code == 200


def test_static_assets_stay_public(client, monkeypatch, tmp_path) -> None:
    """The receiver needs the CSS/JS, and they carry no episode data."""
    (tmp_path / 'app.js').write_text('// code', encoding='utf-8')
    monkeypatch.setattr(tv, 'VIEWER_DIR', tmp_path)
    assert client.get('/static/app.js').status_code == 200


def test_receiver_shell_still_cannot_read_data(client) -> None:
    """The shell being public must not extend to the API."""
    assert client.get('/api/episodes?mode=receiver').status_code == 401


# ── Session hand-off ─────────────────────────────────────────────────────────


def test_basic_auth_issues_a_session_cookie(client) -> None:
    """So the page's own XHRs work without re-sending credentials."""
    resp = client.get('/', headers=basic())
    assert tv.AUTH_SESSION_COOKIE_NAME in resp.headers.get('Set-Cookie', '')


def test_session_cookie_from_basic_auth_authenticates_the_api(client) -> None:
    client.get('/', headers=basic())  # cookie is retained by the test client
    assert client.get('/api/auth/status').get_json()['authenticated'] is True


def test_basic_credentials_also_work_directly_on_the_api(client) -> None:
    assert client.get('/api/episodes', headers=basic()).status_code == 200


# ── Configuration edge cases ─────────────────────────────────────────────────


def test_no_challenge_when_auth_is_disabled(client, monkeypatch) -> None:
    monkeypatch.setattr(tv, 'AUTH_DISABLED', True)
    assert client.get('/').status_code == 200


def test_no_challenge_when_credentials_are_not_configured(client, monkeypatch) -> None:
    """Challenging with nothing to check against would lock the app shut."""
    monkeypatch.setattr(tv, 'AUTH_PASSWORD', '')
    assert client.get('/').status_code == 200


def test_page_shell_paths_cover_both_pages() -> None:
    assert tv.PAGE_SHELL_PATHS == {'/', '/logs'}
