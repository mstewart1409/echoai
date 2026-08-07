"""Tests for /api/episode transcript assembly."""

import json
import os

import pytest

os.environ.setdefault('TRANSCRIPT_VIEWER_AUTH_DISABLED', '1')

from echoai import transcript_viewer as tv  # noqa: E402


@pytest.fixture
def dirs(monkeypatch, tmp_path):
    downloads = tmp_path / 'downloads'
    transcripts = tmp_path / 'transcripts'
    downloads.mkdir()
    transcripts.mkdir()
    monkeypatch.setattr(tv, 'DOWNLOADS_DIR', downloads)
    monkeypatch.setattr(tv, 'TRANSCRIPTS_DIR', transcripts)
    monkeypatch.setattr(tv, 'AUTH_DISABLED', True)
    (downloads / '001_ep.mp3').write_bytes(b'id3')
    tv.app.config['TESTING'] = True
    return downloads, transcripts, tv.app.test_client()


def test_words_are_stamped_with_their_segment(dirs) -> None:
    """Two segments sharing identical text must still own their own words.

    The viewer used to re-derive this by matching word['context'] against
    segment text, which silently gave segment 0 every word of segment 1.
    """
    _, transcripts, client = dirs
    duplicate = 'Ja genau.'
    (transcripts / '001_ep.json').write_text(
        json.dumps(
            [
                {'start': 0, 'end': 1, 'text': duplicate, 'words': [{'word': 'Ja', 'start': 0, 'end': 1}]},
                {'start': 1, 'end': 2, 'text': duplicate, 'words': [{'word': 'genau', 'start': 1, 'end': 2}]},
            ]
        ),
        encoding='utf-8',
    )
    words = client.get('/api/episode/001_ep').get_json()['words']
    assert [w['segment_index'] for w in words] == [0, 1]


def test_malformed_segment_does_not_lose_the_episode(dirs) -> None:
    """Per-item isolation: one bad segment must not 500 the whole request."""
    _, transcripts, client = dirs
    (transcripts / '001_ep.json').write_text(
        json.dumps(
            [
                {'start': 0, 'end': 1, 'text': 'gut', 'avg_logprob': 'not-a-number'},
                {'start': 1, 'end': 2, 'text': 'weiter', 'words': [{'word': 'weiter'}]},
                'not a segment',
                {'no start key': True},
            ]
        ),
        encoding='utf-8',
    )
    resp = client.get('/api/episode/001_ep')
    assert resp.status_code == 200
    assert [s['text'] for s in resp.get_json()['segments']] == ['weiter']


def test_corrupt_json_falls_back_to_srt(dirs) -> None:
    """A broken .json must not shadow a usable .srt."""
    _, transcripts, client = dirs
    (transcripts / '001_ep.json').write_text('{not json', encoding='utf-8')
    (transcripts / '001_ep.srt').write_text(
        '1\n00:00:00,000 --> 00:00:02,000\nHallo\n', encoding='utf-8'
    )
    payload = client.get('/api/episode/001_ep').get_json()
    assert payload['transcript_type'] == 'srt'
    assert payload['segments'][0]['text'] == 'Hallo'


def test_transcript_type_prefers_json_then_srt_then_txt(dirs) -> None:
    _, transcripts, _ = dirs
    assert tv.transcript_type_for('001_ep') == 'none'
    (transcripts / '001_ep.txt').write_text('x', encoding='utf-8')
    assert tv.transcript_type_for('001_ep') == 'txt'
    (transcripts / '001_ep.srt').write_text('x', encoding='utf-8')
    assert tv.transcript_type_for('001_ep') == 'srt'
    (transcripts / '001_ep.json').write_text('[]', encoding='utf-8')
    assert tv.transcript_type_for('001_ep') == 'json'
