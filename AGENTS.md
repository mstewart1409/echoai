# AGENTS.md — AI Coding Rules

## What this project is

**echoai** — a self-hosted toolkit for learning German from the Easy German
podcast. Three pieces:

1. `scripts/download_podcasts.py` — scrapes easygerman.org and downloads episode MP3s.
2. `scripts/transcribe_podcasts.py` — transcribes MP3s locally with OpenAI Whisper into `.txt`/`.srt`/`.json`.
3. `echoai/transcript_viewer.py` — a Flask app serving a browser UI (`echoai/viewer/`) that plays an episode with a synced, clickable transcript, offers word-level German→English translation and spaCy-based grammatical analysis, and can cast to a Chromecast.

Scripts are **offline batch tools**, run manually. The viewer is the only
long-running service — it is deployed as a Docker container (typically on a
Raspberry Pi) and is exposed to a home network, so it is auth-gated.

Deployment target is a Raspberry Pi running the published GHCR image under
Docker Compose — see **Deployment** below and `docs/RASPBERRY_PI_DEPLOYMENT.md`.

---

## Non-negotiables

Ordered. When rules conflict, higher wins.

1. **Security** — this app serves files from disk and is network-exposed.
2. **Don't break the working thing** — no drive-by refactors of code you weren't asked to touch.
3. **Simplicity** — the smallest correct change wins.

---

## Use CodeGraph to read the code

This repo is indexed by CodeGraph (there is a `.codegraph/` directory at the
root). It is a queryable graph of every symbol, call edge, and file.

**Reach for it before grep/glob/reading files** whenever you need to find or
understand code. One call returns the verbatim, line-numbered source of the
relevant symbols *plus* the call paths between them — replacing a
grep-then-open-five-files loop with a single round-trip.

* MCP tool: `codegraph_explore` with `projectPath` set to this repo root.
* Shell equivalent: `codegraph explore "<symbols or question>"`.

The query can be a natural-language question or just a bag of names:

```
codegraph_explore("how does a media request get authorised")
codegraph_explore("_mint_cast_token _verify_cast_token _extract_cast_token_from_request")
codegraph_explore("parse_srt api_episode transcript_viewer.py")
```

Source returned by CodeGraph counts as already read — **do not re-open those
files with Read**. Fall back to Grep/Glob only for what the graph does not
cover: `echoai/viewer/app.js` internals, config files, workflow YAML, Markdown.

Two places this matters most:

* **Before changing a shared helper** — one `codegraph_explore` on its name lists every caller, so you fix the root cause instead of one path.
* **Before adding a route or helper** — check whether one already exists. Reuse beats rewrite, and this repo has a lot of small `_`-prefixed helpers.

Do not run `codegraph init` or re-index; that is the user's call.

---

## Core principles

* **Understand before editing.** Read the whole flow the change touches — the Flask route, the JS that calls it, the data it reads. Start with `codegraph_explore`. A confident wrong fix costs more than a slow right one.
* **Fix root causes, not symptoms.** Grep every caller before patching one path.
* **Prefer the standard library**, then an already-installed dependency (Flask, requests, spaCy, dotenv). Do not add a dependency for what ten lines can do.
* **Delete over add.** Fewer files, fewer layers, fewer knobs.
* **No speculative abstraction.** No interface with one implementation, no config for a value that never changes, no plugin system for one plugin. YAGNI.
* **Explicit over implicit.** No magic, no hidden global mutation.
* **Small functions** — roughly ≤ 40 lines. Extract a helper when it grows past that, not before.
* **Boring over clever.** Someone reads this at 3am.

---

## Layout

```
echoai/
├── echoai/
│   ├── __init__.py             # __version__ only (bumped by commitizen)
│   ├── transcript_viewer.py    # Flask app: config, auth, cast tokens, NLP, routes
│   └── viewer/                 # Static front-end (no build step)
│       ├── index.html
│       ├── app.js              # Vanilla JS — player, transcript sync, cast sender
│       └── styles.css
├── scripts/                    # Standalone batch tools (dependency group: scripts)
│   ├── download_podcasts.py
│   └── transcribe_podcasts.py
├── tests/                      # pytest
├── docs/                       # Deployment notes
├── downloads/                  # MP3s (gitignored, mounted read-only in Docker)
├── transcripts/                # .txt/.srt/.json (gitignored, mounted read-only)
├── .github/workflows/          # lint-test, build, deploy-dev, deploy-prod, release
├── Dockerfile                  # Multi-stage, digest-pinned, non-root
└── docker-compose.yml          # Hardened: read_only, cap_drop ALL, mem/pid limits
```

### Where code goes

| Concern | Location |
|---|---|
| HTTP route, request parsing, response shaping | `transcript_viewer.py` route function — thin |
| Auth, sessions, cast token mint/verify | `transcript_viewer.py` `_`-prefixed helpers |
| Transcript parsing, translation, spaCy analysis | Module-level pure functions in `transcript_viewer.py` |
| UI behaviour, playback, cast sender | `echoai/viewer/app.js` |
| One-off bulk work (download, transcribe) | `scripts/` — never imported by the app |

`transcript_viewer.py` is a single module on purpose. Split it only when it
becomes genuinely hard to navigate — and then along a real seam (e.g. auth,
or NLP), not into a scaffold of near-empty files.

**Never** import `scripts/` from `echoai/`. Scripts may depend on the
`scripts` dependency group (bs4, whisper, tqdm); the app must not.

---

## Security rules

The viewer serves arbitrary files from `downloads/` and `transcripts/` and is
reachable from the LAN. These are hard requirements.

* **Every route is authenticated** unless deliberately public. New routes are covered by the existing `before_request` gate — do not add an exemption without saying why.
* **Validate every path component.** Episode IDs go through `_validate_episode_id` (`^[A-Za-z0-9_-]+$`). Never interpolate user input into a filesystem path; use `send_from_directory` with a validated name. Path traversal is the top risk in this codebase.
* **Bound every user-supplied input** — length caps on translate/analyse text, integer parsing with a safe fallback, reject unexpected types.
* **Compare secrets with `hmac.compare_digest`**, never `==`.
* **Cast tokens are HMAC-signed and time-limited.** Do not add an unsigned media path.
* **No secrets in source.** Everything via `.env` / env vars; `.env` is gitignored and scanned by detect-secrets.
* **`_validate_secrets()` must fail startup** on missing or weak credentials in a non-disabled-auth deployment.
* **Don't log secrets, tokens, or session ids.** Log identifiers, counts, and error types.
* **Keep the response security headers** applied in `apply_security_headers`.
* **Every cache is bounded** (`BoundedCache`) — no unbounded dict keyed by user input.

---

## Code style

* Python 3.14. Ruff enforced: line length 100, **single quotes**, `uv run ruff check --fix` and `uv run ruff format`.
* Type hints on every function signature. `X | None`, not `Optional[X]`.
* Docstrings on public functions — one line is fine when the name already says it.
* Module constants `UPPER_SNAKE_CASE`; private helpers `_prefixed`.
* **All imports at the top of the file.** No deferred or conditional imports inside functions (loading the spaCy model lazily is the one sanctioned exception, and it already exists).
* Logging via `logging.getLogger(__name__)`. **No `print()`** in `echoai/` — `print`/`tqdm` output is fine in `scripts/`, which are CLIs.
* JS: vanilla, no framework, no build step. Keep it that way. No inline `<script>`/`<style>` blocks in `index.html`.

---

## Error handling

* Fail fast on bad input at the boundary — return `400` with a short, non-leaky message.
* Never leak tracebacks, paths, or internal errors to the client.
* Log failures with `logger.exception` and enough context to find them.
* **Per-item isolation in batch loops.** One broken episode, MP3, or SRT file must not abort the rest — `try/except` inside the loop, log, continue.
* Downloads and scrapes retry with backoff on transient network errors, then give up and report.
* No bare `except:`. No silently swallowed exception — log or re-raise.

---

## Testing

* `pytest`, `pythonpath = ["."]`, tests in `tests/`. Run with `uv run pytest`.
* **Non-trivial logic ships with one runnable check** — the smallest test that fails if the logic breaks. Parsers, validators, auth/token paths, and timestamp maths qualify. Trivial one-liners do not.
* **Always test:** `_validate_episode_id` and any path handling, cast token mint/verify (including expiry and tampering), session expiry and reaping, `parse_srt` / `parse_srt_timecode`, `BoundedCache` eviction.
* **Never make real network calls or download models in tests.** Mock `requests`, mock spaCy, mock Whisper.
* Prefer plain functions and `assert` over fixtures and framework machinery. No fixture unless two tests share it.
* `tests/` is excluded from ruff and from coverage.

---

## Tooling & workflow

| Task | Command |
|---|---|
| Install | `uv sync` |
| Run viewer | `uv run python -m echoai.transcript_viewer` |
| Download episodes | `uv run --group scripts python scripts/download_podcasts.py` |
| Transcribe | `uv run --group scripts python scripts/transcribe_podcasts.py` |
| Lint + format | `uv run ruff check --fix . && uv run ruff format .` |
| Test | `uv run pytest` |
| All hooks | `uv run pre-commit run --all-files` |

* **`uv` only** — never `pip install`. Dependency changes go in `pyproject.toml`, then `uv lock` (the pre-commit hook enforces a current lockfile).
* **Conventional Commits**, enforced by commitizen at commit-msg. Versions are bumped by the release workflow, never by hand.
* **PRs target `develop`.** Never open a PR against `main`.
* Pre-commit runs ruff, detect-secrets, and the full pytest suite. CI additionally runs `uv audit`.
* Pin GitHub Actions by commit SHA and base images by digest — keep it that way.

---

## Deployment

`docs/RASPBERRY_PI_DEPLOYMENT.md` is the source of truth for the production
deployment. Read it before changing anything that touches runtime config, the
Dockerfile, `docker-compose.yml`, or `.env.example` — and update it in the same
change if the deployment steps or required variables change.

**Pipeline.** Push to `develop` → `deploy-dev.yml` cuts a `beta` pre-release
(commitizen bump + tag) then calls `build.yml`, which builds the
multi-arch image and pushes it to GHCR with the `dev` tag prefix. Push to `main`
does the same via `deploy-prod.yml` with a stable version and the `prod` prefix.
Never bump the version by hand.

**Runtime.** A Raspberry Pi runs the GHCR image under Docker Compose from
`/home/pi/echoai`, with `downloads/`, `transcripts/`, and `.env` (mode `600`)
alongside `docker-compose.yml`. Watchtower polls GHCR and restarts the labeled
container on a new image. Public access is via Cloudflare Tunnel, which
terminates TLS; the container port is bound to `127.0.0.1:5000` only.

**Constraints the code must respect:**

* `downloads/` and `transcripts/` are mounted **read-only**; the root filesystem is `read_only: true` with only `/tmp` writable. The app must never write to disk outside `/tmp`.
* 512 MB memory and 100 PIDs. Don't load large models eagerly or spawn processes.
* Runs as non-root `appuser`. No privileged operations, no writing outside the volumes.
* ARM64 as well as x86_64 — no architecture-specific or wheel-less dependency.
* Production sets `AUTH_DISABLED=0`, `COOKIE_SECURE=1`, `CAST_TOKEN_REQUIRED_FOR_MEDIA=1`. New code must behave correctly under all three.
* `AUTH_PASSWORD`, `AUTH_SESSION_SECRET`, and `CAST_SIGNING_KEY` are independent secrets. `_validate_secrets()` logs `SECURITY:` warnings on weak or reused values — keep those checks working, and add one for any new secret.
* Sessions are in-memory: a restart or redeploy logs everyone out. Don't build anything that assumes state survives a restart.

**Any new environment variable** goes in `.env.example` with a comment, gets a
safe default in `transcript_viewer.py`, and is documented in the Pi guide if
production must set it.

---

## Forbidden

* Interpolating unvalidated user input into a filesystem path.
* A new route that bypasses authentication without an explicit, stated reason.
* A new runtime dependency where the stdlib or an installed package will do.
* A JS build step, bundler, or front-end framework.
* `print()` in `echoai/`, lazy imports, bare `except:`, mutable default arguments.
* Unbounded caches, queues, or retry loops.
* Shim modules that only re-export from somewhere else.
* Hardcoded secrets, or logging them.
* Committing anything from `downloads/` or `transcripts/`.
* Refactoring unrelated code in the same change.

---

## Adding a feature

1. Read the existing flow end to end — route, helper, JS caller.
2. Check whether a helper already covers it. Reuse beats rewrite.
3. Write the smallest version that works, in the module that owns the concern.
4. Validate and bound any new user input.
5. Add one test if the logic can break.
6. `uv run ruff format . && uv run pytest`.
7. Mark deliberate shortcuts with a `# ponytail:` comment naming the ceiling and the upgrade path.

When unsure: pick the simpler option, keep the handler thin, and say what you
skipped.
