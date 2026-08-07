# echoai

A self-hosted toolkit for learning German from the
[Easy German](https://www.easygerman.org/podcast) podcast.

Download episodes, transcribe them locally with Whisper, then study them in a
browser: audio playback with a synced, clickable transcript, hover-to-translate
on any word, spaCy grammar analysis, and Chromecast support so you can put the
transcript on a TV.

Everything runs on your own hardware. The only external calls are fetching the
podcast and word translations.

---

## What's in the box

| Piece | What it does |
|---|---|
| `scripts/download_podcasts.py` | Scrapes easygerman.org and downloads episode MP3s |
| `scripts/transcribe_podcasts.py` | Transcribes MP3s locally with OpenAI Whisper → `.txt` / `.srt` / `.json` |
| `echoai/transcript_viewer.py` | Flask app serving the browser UI, translation, grammar analysis, and Cast auth |
| `echoai/viewer/` | The front end — vanilla JS, no build step |

The two scripts are offline batch tools you run by hand. The viewer is the only
long-running service.

---

## Requirements

- **Python 3.14+** and [uv](https://docs.astral.sh/uv/)
- **ffmpeg** on `PATH` (Whisper needs it) — `winget install ffmpeg`, `brew install ffmpeg`, or `apt install ffmpeg`
- Disk space for MP3s and Whisper models (the default `medium` model is ~1.5 GB)

---

## Quickstart

```bash
uv sync
uv run python -m spacy download de_core_news_sm
```

**1. Download some episodes.** Start small — there are hundreds.

```bash
uv run --group scripts python scripts/download_podcasts.py --limit 5
```

**2. Transcribe them.** This is the slow part; it runs entirely on your machine.

```bash
uv run --group scripts python scripts/transcribe_podcasts.py --limit 5
```

**3. Run the viewer.**

```bash
cp .env.example .env      # then fill in the secrets — see below
uv run python -m echoai.transcript_viewer
```

Open <http://localhost:5000>.

MP3s land in `downloads/`, transcripts in `transcripts/`. Both are gitignored.

### Script options

`download_podcasts.py`

| Flag | Default | Meaning |
|---|---|---|
| `-n`, `--limit N` | all | Maximum episodes to download |

`transcribe_podcasts.py`

| Flag | Default | Meaning |
|---|---|---|
| `-m`, `--model` | `medium` | `tiny` \| `base` \| `small` \| `medium` \| `large` |
| `-f`, `--format` | `json` | `txt` \| `srt` \| `json` \| `all` |
| `-l`, `--language` | `de` | Language code passed to Whisper |
| `-i`, `--input` | `downloads/` | Folder of MP3s |
| `-n`, `--limit` | all | Maximum files to process |
| `--ffmpeg-path` | auto | Explicit ffmpeg location |

Use `json` (the default) unless you have a reason not to — it carries
word-level timings, which is what drives per-word highlighting and translation.
`srt` gives segment-level sync only; `txt` gives no sync at all.

---

## Configuration

All settings are environment variables, read from `.env`. Copy `.env.example`
and fill it in. The ones that matter:

| Variable | Notes |
|---|---|
| `TRANSCRIPT_VIEWER_AUTH_USERNAME` | Login user |
| `TRANSCRIPT_VIEWER_AUTH_PASSWORD` | **≥ 16 chars**, random |
| `TRANSCRIPT_VIEWER_AUTH_SESSION_SECRET` | **64 hex chars** — `python -c "import secrets; print(secrets.token_hex(32))"` |
| `TRANSCRIPT_VIEWER_CAST_SIGNING_KEY` | **64 hex chars**, different from the session secret |
| `TRANSCRIPT_VIEWER_CAST_RECEIVER_APP_ID` | Your Cast app ID — see [docs/CHROMECAST.md](docs/CHROMECAST.md) |
| `TRANSCRIPT_VIEWER_COOKIE_SECURE` | `1` in production, `0` when testing over plain HTTP |
| `TRANSCRIPT_VIEWER_AUTH_DISABLED` | `1` for local development only |

Those three secrets must be **independent values**. The app logs `SECURITY:`
warnings at startup if they're weak or reused — read the logs the first time
you start it.

For local poking about you can skip auth entirely:

```bash
TRANSCRIPT_VIEWER_AUTH_DISABLED=1 uv run python -m echoai.transcript_viewer
```

---

## Using the viewer

- **Click a line** to jump the audio there; **click a word** to jump to that word.
- **Hover a word** for its English translation plus grammar (part of speech, case, gender, lemma, dependency role). "Explain to me" expands that into examples.
- **Translations** toggle segment-level English captions under each line.
- **Fullscreen** gives a distraction-free transcript, and is also what the Chromecast shows.
- **Cast** sends audio to a Chromecast while the browser keeps the transcript in sync.

### Chromecast

Casting needs a registered Custom Web Receiver — the Default Media Receiver
cannot run our page, so you'd get audio with no transcript. **Read
[docs/CHROMECAST.md](docs/CHROMECAST.md) before trying**; it covers registration,
the 15-minute device-registration wait, the HTTPS rules, and a local test
procedure that doesn't require deploying.

---

## Deployment

The viewer is packaged as a multi-arch Docker image published to GHCR, intended
for a Raspberry Pi behind a Cloudflare Tunnel.
[docs/RASPBERRY_PI_DEPLOYMENT.md](docs/RASPBERRY_PI_DEPLOYMENT.md) is the source
of truth.

The container is locked down: read-only root filesystem, read-only data mounts,
`cap_drop: ALL`, non-root user, 512 MB / 100 PID limits. Sessions are in-memory,
so a restart logs everyone out.

Push to `develop` cuts a beta pre-release and publishes a `dev` image; push to
`main` does the same for `prod`. Versions are bumped by the release workflow —
never by hand.

---

## Development

| Task | Command |
|---|---|
| Install | `uv sync` |
| Run viewer | `uv run python -m echoai.transcript_viewer` |
| Lint + format | `uv run ruff check --fix . && uv run ruff format .` |
| Test | `uv run pytest` |
| All hooks | `uv run pre-commit run --all-files` |

`uv run pytest` covers both the Python suite and a JavaScript smoke test that
executes `echoai/viewer/app.js` against a stub DOM (skipped if `node` is
absent). That smoke test exists because a refactor once silently deleted the
app's entire bootstrap and nothing noticed — see `tests/viewer/`.

Use `uv` only, never `pip install`. Dependency changes go in `pyproject.toml`
followed by `uv lock`; a pre-commit hook enforces a current lockfile. Commits
follow [Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitizen. **PRs target `develop`, never `main`.**

`AGENTS.md` holds the full contributor rules — architecture, security
requirements, and what not to do.

### HTTP API

All routes require authentication unless noted.

| Route | Purpose |
|---|---|
| `GET /` | The app shell (public) |
| `GET /api/episodes` | Episode index |
| `GET /api/episode/<id>` | Transcript, segments, word timings |
| `GET /media/<file>` | Episode audio |
| `GET /api/translate` | Word translation + grammar analysis |
| `GET /api/translate-text` | Segment translation |
| `GET /api/explain` | Longer explanation for a word |
| `GET /api/config` | Client runtime config |
| `POST /api/auth/login` `/logout`, `GET /api/auth/status` | Session auth |
| `POST /api/cast/session` `/validate`, `GET /api/cast/debug` | Cast tokens and diagnostics |

---

## Troubleshooting

**No episodes listed.** The viewer pairs `downloads/*.mp3` with transcripts by
filename stem. An MP3 with no matching transcript still appears, but with
`transcript_type: none`.

**Transcription fails immediately.** ffmpeg isn't on `PATH`. Pass
`--ffmpeg-path` or install it.

**Everything returns 401.** Auth is enabled but credentials aren't fully
configured, or your session expired — sessions don't survive a restart.

**Cast button never appears.** The Cast SDK needs a secure context.
`http://localhost` counts; a bare LAN IP over HTTP does not. See
[docs/CHROMECAST.md](docs/CHROMECAST.md).

**Grammar hints look thin.** The spaCy model isn't installed, so the app fell
back to a blank pipeline. Run `uv run python -m spacy download de_core_news_sm`
and check the startup logs.

---

## Licence

Proprietary. Easy German podcast content belongs to its creators — this project
only helps you study episodes you've downloaded for personal use.
