"""Tests for log capture, parsing, filtering, and the protection on /api/logs.

The log viewer exposes diagnostics, so the access rules matter as much as the
parsing: a cast token lives on a TV anyone in the room can reach and must never
open the log API.
"""

import logging
import os
import sys

import pytest

os.environ.setdefault('TRANSCRIPT_VIEWER_AUTH_DISABLED', '1')
os.environ.setdefault('TRANSCRIPT_VIEWER_CAST_SIGNING_KEY', 'k' * 64)

from echoai import transcript_viewer as tv  # noqa: E402

SAMPLE = [
    '2026-08-08 10:00:00,001 INFO echoai.transcript_viewer GET /api/episodes → 200 (4ms)',
    '2026-08-08 10:00:01,002 WARNING echoai.transcript_viewer GET /nope → 404 (1ms)',
    '2026-08-08 10:00:02,003 ERROR echoai.client [receiver] cast token request failed',
]


# ── Parsing ──────────────────────────────────────────────────────────────────


def test_parse_log_lines_extracts_fields() -> None:
    records = tv.parse_log_lines(SAMPLE)
    assert len(records) == 3
    assert records[0]['level'] == 'INFO'
    assert records[0]['name'] == 'echoai.transcript_viewer'
    assert records[0]['ts'] == '2026-08-08 10:00:00,001'
    assert 'GET /api/episodes' in records[0]['message']


def test_parse_log_lines_folds_tracebacks_into_one_record() -> None:
    """A traceback is many physical lines but one logical record."""
    lines = [
        '2026-08-08 10:00:00,001 ERROR echoai.transcript_viewer boom',
        'Traceback (most recent call last):',
        '  File "x.py", line 1, in <module>',
        'ValueError: bad',
    ]
    records = tv.parse_log_lines(lines)
    assert len(records) == 1
    assert 'ValueError: bad' in records[0]['message']


def test_parse_log_lines_drops_orphan_continuations() -> None:
    """A tail read can start mid-traceback; those lines have no parent record."""
    assert tv.parse_log_lines(['  File "x.py", line 1', 'ValueError: bad']) == []


def test_parse_log_lines_handles_empty_input() -> None:
    assert tv.parse_log_lines([]) == []


# ── Filtering ────────────────────────────────────────────────────────────────


def test_filter_by_level() -> None:
    records = tv.parse_log_lines(SAMPLE)
    assert len(tv.filter_log_records(records, levels={'ERROR'})) == 1
    assert len(tv.filter_log_records(records, levels={'INFO', 'WARNING'})) == 2


def test_filter_by_source_separates_client_from_server() -> None:
    """The whole point of the source filter: isolate Chromecast-side logs."""
    records = tv.parse_log_lines(SAMPLE)
    client_only = tv.filter_log_records(records, source='echoai.client')
    assert len(client_only) == 1
    assert 'cast token request failed' in client_only[0]['message']


def test_filter_search_is_case_insensitive() -> None:
    records = tv.parse_log_lines(SAMPLE)
    assert len(tv.filter_log_records(records, search='CAST TOKEN')) == 1


def test_filters_combine() -> None:
    records = tv.parse_log_lines(SAMPLE)
    assert tv.filter_log_records(records, levels={'INFO'}, search='cast token') == []


def test_no_filters_returns_everything() -> None:
    assert len(tv.filter_log_records(tv.parse_log_lines(SAMPLE))) == 3


# ── Redaction ────────────────────────────────────────────────────────────────


def test_redact_query_hides_cast_token() -> None:
    """`rt` is a signed media token — logging it would grant media access."""
    assert tv._redact_query('rt=abc.def.ghi') == 'rt=<redacted>'


def test_redact_query_keeps_harmless_params() -> None:
    assert tv._redact_query('episode=123_ep&limit=5') == 'episode=123_ep&limit=5'


def test_redact_query_handles_mixed_and_empty() -> None:
    assert tv._redact_query('episode=1&rt=secret') == 'episode=1&rt=<redacted>'
    assert tv._redact_query('') == ''


# ── scrub_secrets: the chokepoint every log line passes through ──────────────


def test_scrub_removes_a_real_cast_token() -> None:
    """The strongest check: mint a genuine token and prove it cannot be logged."""
    token, _ = tv._mint_cast_token('123_ep')
    scrubbed = tv.scrub_secrets(f'loading media with token {token}')
    assert token not in scrubbed
    assert tv.REDACTED in scrubbed


def test_scrub_removes_a_real_session_id(monkeypatch) -> None:
    monkeypatch.setattr(tv, 'AUTH_SESSION_SECRET', 's' * 64)
    sid, _ = tv._new_auth_session('alice')
    assert sid not in tv.scrub_secrets(f'cookie was {sid}')


def test_scrub_removes_configured_secrets_by_value(monkeypatch) -> None:
    """Backstop: even a future call site that logs the password directly is safe."""
    monkeypatch.setattr(tv, 'AUTH_PASSWORD', 'hunter2-correct-horse')
    monkeypatch.setattr(tv, 'CAST_SIGNING_KEY', 'c' * 64)
    monkeypatch.setattr(tv, 'AUTH_SESSION_SECRET', 'd' * 64)
    text = 'password=hunter2-correct-horse key=' + 'c' * 64
    scrubbed = tv.scrub_secrets(text)
    assert 'hunter2-correct-horse' not in scrubbed
    assert 'c' * 64 not in scrubbed


def test_scrub_ignores_a_short_secret(monkeypatch) -> None:
    """An 8-char floor stops a weak password from redacting ordinary words."""
    monkeypatch.setattr(tv, 'AUTH_PASSWORD', 'the')
    assert 'the quick brown fox' in tv.scrub_secrets('the quick brown fox')


@pytest.mark.parametrize(
    'text',
    [
        'rt=eyJhbGciOiJIUzI1NiJ9',
        'token: abc123def456ghi789',
        'password=s3cr3tvalue',
        'Authorization: Bearer abc.def.ghi',
        'X-Api-Key api_key=abcdef123456',
        'sid=alice:123:nonce',
    ],
)
def test_scrub_catches_secret_shaped_values(text: str) -> None:
    assert tv.REDACTED in tv.scrub_secrets(text)


@pytest.mark.parametrize(
    'text',
    [
        'GET /api/episodes → 200 (4ms)',
        'loaded episode 123_egp654',
        'sending 123_egp654.mp3 from /app/downloads',
        'logging to /tmp/echoai.log',
        'echoai 0.13.0 starting',
        'spaCy model de_core_news_sm loaded',
        'drift correction: 1.2s',
    ],
)
def test_scrub_leaves_ordinary_log_lines_intact(text: str) -> None:
    """Over-redaction would make the log viewer useless — these must survive."""
    assert tv.scrub_secrets(text) == text


def test_scrub_handles_empty_input() -> None:
    assert tv.scrub_secrets('') == ''


# ── RedactingFormatter: covers message, args and tracebacks ──────────────────


def _format(record: logging.LogRecord) -> str:
    return tv.RedactingFormatter(tv.LOG_FORMAT).format(record)


def test_formatter_scrubs_interpolated_arguments() -> None:
    """The secret usually arrives as a %s argument, not in the format string."""
    token, _ = tv._mint_cast_token('123_ep')
    record = logging.LogRecord(
        'echoai.server', logging.INFO, __file__, 1, 'media url %s', (token,), None
    )
    assert token not in _format(record)


def test_formatter_scrubs_a_traceback() -> None:
    """Tracebacks render in the formatter, so scrubbing the message is not enough."""
    token, _ = tv._mint_cast_token('123_ep')
    try:
        raise ValueError(f'bad token {token}')
    except ValueError:
        record = logging.LogRecord(
            'echoai.server', logging.ERROR, __file__, 1, 'failed', (), sys.exc_info()
        )
    assert token not in _format(record)


def test_formatter_scrubs_client_shipped_messages(open_client, tmp_path, monkeypatch) -> None:
    """Client logs are attacker-controlled — a token in one must not reach the file."""
    token, _ = tv._mint_cast_token('123_ep')
    path = tmp_path / 'echoai.log'
    monkeypatch.setattr(tv, 'LOG_FILE', str(path))
    try:
        tv._configure_logging()
        open_client.post(
            '/api/logs/client',
            json={'entries': [{'level': 'INFO', 'msg': f'media url ?rt={token}'}]},
        )
        for handler in logging.getLogger().handlers:
            handler.flush()
        assert token not in path.read_text(encoding='utf-8')
    finally:
        for handler in list(logging.getLogger().handlers):
            handler.close()
            logging.getLogger().removeHandler(handler)


def test_login_failure_logs_username_but_never_the_password(client, caplog) -> None:
    with caplog.at_level(logging.WARNING, logger='echoai.server'):
        client.post('/api/auth/login', json={'username': 'alice', 'password': 'sup3rs3cret-pw'})
    logged = '\n'.join(tv.scrub_secrets(r.getMessage()) for r in caplog.records)
    assert 'sup3rs3cret-pw' not in logged
    assert 'alice' in logged


# ── Tail reading ─────────────────────────────────────────────────────────────


def test_read_log_tail_returns_lines(monkeypatch, tmp_path) -> None:
    path = tmp_path / 'echoai.log'
    path.write_text('\n'.join(SAMPLE), encoding='utf-8')
    monkeypatch.setattr(tv, 'LOG_FILE', str(path))
    assert len(tv._read_log_tail()) == 3


def test_read_log_tail_is_bounded_and_drops_partial_first_line(monkeypatch, tmp_path) -> None:
    """A huge log must never be read whole — the Pi has 512 MB."""
    path = tmp_path / 'echoai.log'
    path.write_text('\n'.join(f'line-{i:05d}' for i in range(5000)), encoding='utf-8')
    monkeypatch.setattr(tv, 'LOG_FILE', str(path))
    lines = tv._read_log_tail(max_bytes=200)
    assert 0 < len(lines) < 5000
    assert all(line.startswith('line-') for line in lines)


def test_read_log_tail_survives_a_missing_file(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(tv, 'LOG_FILE', str(tmp_path / 'nope.log'))
    assert tv._read_log_tail() == []


# ── API access control ───────────────────────────────────────────────────────


@pytest.fixture
def client(monkeypatch):
    """Flask test client with auth enforced, as in production."""
    monkeypatch.setattr(tv, 'AUTH_DISABLED', False)
    monkeypatch.setattr(tv, 'CAST_SIGNING_KEY', 'k' * 64)
    tv.app.config['TESTING'] = True
    return tv.app.test_client()


def test_logs_api_rejects_unauthenticated(client) -> None:
    assert client.get('/api/logs').status_code == 401


def test_logs_api_rejects_a_cast_token(client) -> None:
    """Logs are diagnostics — a token sitting on a TV must not read them."""
    token, _ = tv._mint_cast_token('123_ep')
    assert client.get(f'/api/logs?rt={token}').status_code == 401


def test_logs_path_is_in_session_only_paths() -> None:
    assert '/api/logs' in tv.SESSION_ONLY_PATHS


def test_client_log_ingest_accepts_a_cast_token(client) -> None:
    """The receiver has no cookies; without this its logs never reach the Pi."""
    token, _ = tv._mint_cast_token(tv.CAST_SCOPE_ANY)
    resp = client.post(
        f'/api/logs/client?rt={token}',
        json={'source': 'receiver', 'entries': [{'level': 'ERROR', 'msg': 'boom'}]},
    )
    assert resp.status_code == 200
    assert resp.get_json()['accepted'] == 1


def test_client_log_ingest_rejects_unauthenticated(client) -> None:
    resp = client.post('/api/logs/client', json={'entries': [{'level': 'INFO', 'msg': 'x'}]})
    assert resp.status_code == 401


# ── Client log ingest bounds ─────────────────────────────────────────────────


@pytest.fixture
def open_client(monkeypatch):
    """Test client with auth off, for exercising ingest limits directly."""
    monkeypatch.setattr(tv, 'AUTH_DISABLED', True)
    tv.app.config['TESTING'] = True
    return tv.app.test_client()


def test_client_log_ingest_caps_entry_count(open_client) -> None:
    """Everything here is attacker-controlled — the batch size must be clamped."""
    entries = [{'level': 'INFO', 'msg': f'line {i}'} for i in range(500)]
    resp = open_client.post('/api/logs/client', json={'entries': entries})
    assert resp.get_json()['accepted'] == tv.CLIENT_LOG_MAX_ENTRIES


def test_client_log_ingest_truncates_long_messages(open_client, caplog) -> None:
    with caplog.at_level(logging.INFO, logger='echoai.client'):
        open_client.post('/api/logs/client', json={'entries': [{'level': 'INFO', 'msg': 'x' * 9000}]})
    assert any(len(record.getMessage()) < 2000 for record in caplog.records)


def test_client_log_ingest_strips_newlines(open_client, caplog) -> None:
    """A newline in the message would forge an extra record in the log file."""
    with caplog.at_level(logging.INFO, logger='echoai.client'):
        open_client.post(
            '/api/logs/client',
            json={'entries': [{'level': 'INFO', 'msg': 'real\n2026-01-01 00:00:00,000 ERROR fake'}]},
        )
    assert all('\n' not in record.getMessage() for record in caplog.records)


def test_client_log_ingest_rejects_a_non_list_payload(open_client) -> None:
    assert open_client.post('/api/logs/client', json={'entries': 'nope'}).status_code == 400


def test_client_log_ingest_ignores_junk_entries(open_client) -> None:
    """One malformed entry must not lose the whole batch."""
    resp = open_client.post(
        '/api/logs/client',
        json={'entries': ['string', 42, None, {'level': 'INFO', 'msg': 'good'}]},
    )
    assert resp.get_json()['accepted'] == 1


def test_client_log_ingest_falls_back_on_an_unknown_level(open_client) -> None:
    resp = open_client.post(
        '/api/logs/client', json={'entries': [{'level': 'HAXX', 'msg': 'still logged'}]}
    )
    assert resp.get_json()['accepted'] == 1


# ── Client log ingest: log forging ───────────────────────────────────────────
#
# The body is fully attacker-controlled. Python's str.splitlines() — which
# parse_log_lines uses — breaks on far more than \r\n, so stripping only those
# let a client inject a fake timestamped record attributed to any logger.


@pytest.mark.parametrize(
    'char',
    ['\n', '\r', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029'],
)
def test_sanitize_neutralises_every_line_breaking_character(char: str) -> None:
    assert len(tv.sanitize_log_text(f'a{char}b').splitlines()) == 1


def test_sanitize_strips_ansi_escapes() -> None:
    """ANSI would rewrite the terminal of anyone running `docker compose logs`."""
    assert '\x1b' not in tv.sanitize_log_text('\x1b[31mred\x1b[0m')


def test_sanitize_keeps_ordinary_text_readable() -> None:
    assert tv.sanitize_log_text('drift correction: 1.2s → 100.4s') == (
        'drift correction: 1.2s → 100.4s'
    )


def test_client_cannot_forge_a_log_record(open_client, monkeypatch, tmp_path) -> None:
    """End-to-end: an injected timestamp must not become a second record."""
    path = tmp_path / 'echoai.log'
    monkeypatch.setattr(tv, 'LOG_FILE', str(path))
    forged = 'real\x852026-01-01 00:00:00,000 ERROR root FORGED ENTRY'
    try:
        tv._configure_logging()
        open_client.post('/api/logs/client', json={'entries': [{'level': 'INFO', 'msg': forged}]})
        for handler in logging.getLogger().handlers:
            handler.flush()
        records = tv.parse_log_lines(tv._read_log_tail())
    finally:
        for handler in list(logging.getLogger().handlers):
            handler.close()
            logging.getLogger().removeHandler(handler)
    assert not any(r['name'] == 'root' for r in records), 'client forged a log record'
    assert not any(r['message'] == 'FORGED ENTRY' for r in records)


def test_client_cannot_forge_via_the_source_field(open_client) -> None:
    """`source` is interpolated into the record too — it needs the same scrub."""
    resp = open_client.post(
        '/api/logs/client',
        json={'source': 'a\nERROR root x', 'entries': [{'level': 'INFO', 'msg': 'hi'}]},
    )
    assert resp.status_code == 200


# ── Client log ingest: flooding and body size ────────────────────────────────


def test_client_log_ingest_is_rate_limited(open_client, monkeypatch) -> None:
    """A flood would rotate genuine evidence out of the bounded log file."""
    monkeypatch.setattr(tv, '_client_log_window_start', 0.0)
    monkeypatch.setattr(tv, '_client_log_window_count', 0)
    monkeypatch.setattr(tv, 'CLIENT_LOG_RATE_MAX_ENTRIES', 3)
    codes = [
        open_client.post('/api/logs/client', json={'entries': [{'level': 'INFO', 'msg': 'x'}]}).status_code
        for _ in range(6)
    ]
    assert 429 in codes, 'rate limit never engaged'
    assert codes[0] == 200


def test_oversized_body_is_rejected(open_client) -> None:
    """Without a cap, one huge POST is parsed into the 512 MB container's memory."""
    huge = 'x' * (tv.MAX_CONTENT_LENGTH + 1024)
    resp = open_client.post(
        '/api/logs/client',
        data=f'{{"entries":[{{"level":"INFO","msg":"{huge}"}}]}}',
        content_type='application/json',
    )
    assert resp.status_code == 413


def test_max_content_length_is_configured() -> None:
    assert tv.app.config['MAX_CONTENT_LENGTH'] == tv.MAX_CONTENT_LENGTH


def test_client_log_ingest_survives_hostile_payload_shapes(open_client) -> None:
    """Malformed input must produce a 4xx, never a traceback."""
    for body in (
        {'entries': [{'level': None, 'msg': None}]},
        {'entries': [{}]},
        {'entries': [{'msg': {'nested': 'object'}}]},
        {},
    ):
        assert open_client.post('/api/logs/client', json=body).status_code in (200, 400)


# ── API response shape ───────────────────────────────────────────────────────


def test_logs_api_returns_filtered_records(open_client, monkeypatch, tmp_path) -> None:
    path = tmp_path / 'echoai.log'
    path.write_text('\n'.join(SAMPLE), encoding='utf-8')
    monkeypatch.setattr(tv, 'LOG_FILE', str(path))
    data = open_client.get('/api/logs?levels=ERROR').get_json()
    assert data['returned'] == 1
    assert data['records'][0]['level'] == 'ERROR'


def test_logs_api_clamps_an_absurd_limit(open_client, monkeypatch, tmp_path) -> None:
    path = tmp_path / 'echoai.log'
    path.write_text('\n'.join(SAMPLE), encoding='utf-8')
    monkeypatch.setattr(tv, 'LOG_FILE', str(path))
    # Must not honour a caller-supplied limit above the server cap.
    assert open_client.get('/api/logs?limit=999999').status_code == 200
    assert open_client.get('/api/logs?limit=notanumber').status_code == 200


# ── Logging configuration ────────────────────────────────────────────────────


def test_configure_logging_writes_to_the_file(monkeypatch, tmp_path) -> None:
    path = tmp_path / 'sub' / 'echoai.log'
    monkeypatch.setattr(tv, 'LOG_FILE', str(path))
    try:
        tv._configure_logging()
        tv.logger.info('hello from the test')
        for handler in logging.getLogger().handlers:
            handler.flush()
        assert 'hello from the test' in path.read_text(encoding='utf-8')
    finally:
        for handler in list(logging.getLogger().handlers):
            handler.close()
            logging.getLogger().removeHandler(handler)


def test_configure_logging_survives_an_unwritable_path(monkeypatch) -> None:
    """The app must still serve when the log path is not writable."""
    monkeypatch.setattr(tv, 'LOG_FILE', '/proc/nope/echoai.log')
    try:
        tv._configure_logging()  # must not raise
    finally:
        for handler in list(logging.getLogger().handlers):
            handler.close()
            logging.getLogger().removeHandler(handler)


def test_configure_logging_silences_werkzeug_access_log(monkeypatch, tmp_path) -> None:
    """Werkzeug logs the RAW request line — that would write live cast tokens
    into the very file the /logs page serves back out."""
    monkeypatch.setattr(tv, 'LOG_FILE', str(tmp_path / 'echoai.log'))
    try:
        tv._configure_logging()
        assert logging.getLogger('werkzeug').level >= logging.ERROR
    finally:
        for handler in list(logging.getLogger().handlers):
            handler.close()
            logging.getLogger().removeHandler(handler)


def test_request_log_line_redacts_the_cast_token(monkeypatch, caplog) -> None:
    """End-to-end: a request carrying ?rt=<token> must not log the token."""
    monkeypatch.setattr(tv, 'AUTH_DISABLED', False)
    monkeypatch.setattr(tv, 'CAST_SIGNING_KEY', 'k' * 64)
    tv.app.config['TESTING'] = True
    token, _ = tv._mint_cast_token('123_ep')
    with caplog.at_level(logging.INFO, logger='echoai.server'):
        tv.app.test_client().get(f'/api/episodes?rt={token}')
    logged = '\n'.join(record.getMessage() for record in caplog.records)
    assert token not in logged, 'cast token leaked into the request log'
    assert 'rt=<redacted>' in logged
