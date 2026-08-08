# Raspberry Pi Production Deployment

Deploy the transcript viewer as a Docker service on a Raspberry Pi. Watchtower
auto-updates it when a new image is published to GHCR. All operations are done
from a Windows machine over SSH.

The Pi lives at `raspberrypi.local` (mDNS) or a static LAN IP; the app runs
under `/home/pi/echoai`. Public access goes through Cloudflare Tunnel — the
container itself only binds to `127.0.0.1:5000`.

---

## 1) One-time Windows setup

### 1.1 Install an SSH client
Windows 10/11 ships with OpenSSH. Verify:
```powershell
ssh -V
```
If missing: `Settings → Apps → Optional features → Add → OpenSSH Client`.

### 1.2 Generate an SSH key (skip if you already have one)
```powershell
ssh-keygen -t ed25519 -C "windows-to-pi"
# Accept default path (C:\Users\<you>\.ssh\id_ed25519), set a passphrase.
```

### 1.3 Copy the key to the Pi
```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh pi@raspberrypi.local "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```
Enter the Pi password once. Every subsequent `ssh pi@raspberrypi.local` uses
the key.

### 1.4 (Optional) SSH shortcut
Add to `C:\Users\<you>\.ssh\config`:
```
Host pi
    HostName raspberrypi.local
    User pi
    IdentityFile ~/.ssh/id_ed25519
```
Then just: `ssh pi`.

---

## 2) One-time Pi setup

### 2.1 Install Docker + Compose plugin
```powershell
ssh pi@raspberrypi.local "curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker pi"
```
Log out and back in for the group to apply:
```powershell
ssh pi@raspberrypi.local "docker version && docker compose version"
```

### 2.2 Create project layout
```powershell
ssh pi@raspberrypi.local "mkdir -p /home/pi/echoai/downloads /home/pi/echoai/transcripts"
```

### 2.3 Log in to GHCR (for pulling the private image + Watchtower auth)
Create a GitHub Personal Access Token with `read:packages` scope, then:
```powershell
ssh pi@raspberrypi.local "echo <GITHUB_PAT> | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin"
```
This writes `/home/pi/.docker/config.json`, which `docker-compose.yml` mounts
into Watchtower.

---

## 3) Configure `.env`

The app reads its configuration from `/home/pi/echoai/.env`. Every setting is
prefixed `TRANSCRIPT_VIEWER_`.

### 3.1 Generate secrets (run on Windows)
```powershell
python -c "import secrets; print('AUTH_PASSWORD =', secrets.token_urlsafe(24))"
python -c "import secrets; print('AUTH_SESSION_SECRET =', secrets.token_hex(32))"
python -c "import secrets; print('CAST_SIGNING_KEY =', secrets.token_hex(32))"
```
The three values MUST be independent — never reuse one as another.
`_validate_secrets()` at startup logs `SECURITY:` warnings on weak or reused
values.

### 3.2 Required variables

| Variable | Value | Notes |
|---|---|---|
| `TRANSCRIPT_VIEWER_AUTH_USERNAME` | your login name | non-empty |
| `TRANSCRIPT_VIEWER_AUTH_PASSWORD` | ≥ 16 chars, random | from generator above |
| `TRANSCRIPT_VIEWER_AUTH_SESSION_SECRET` | ≥ 64 hex chars | independent secret |
| `TRANSCRIPT_VIEWER_CAST_SIGNING_KEY` | ≥ 64 hex chars | independent secret |
| `TRANSCRIPT_VIEWER_CAST_RECEIVER_APP_ID` | your Cast receiver app id | required for Chromecast UI |

### 3.3 Production settings (must be exactly these values)
```dotenv
TRANSCRIPT_VIEWER_AUTH_DISABLED=0
TRANSCRIPT_VIEWER_COOKIE_SECURE=1
TRANSCRIPT_VIEWER_CAST_TOKEN_REQUIRED_FOR_MEDIA=1
```

### 3.4 Optional overrides (defaults shown in `.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `TRANSCRIPT_VIEWER_HOST` | `0.0.0.0` | Container listen address. |
| `TRANSCRIPT_VIEWER_PORT` | `5000` | Container listen port. |
| `TRANSCRIPT_VIEWER_DOWNLOADS_DIR` | `/app/downloads` | Path inside container. |
| `TRANSCRIPT_VIEWER_TRANSCRIPTS_DIR` | `/app/transcripts` | Path inside container. |
| `TRANSCRIPT_VIEWER_STATIC_DIR` | `/app/echoai/viewer` | Path inside container. |
| `TRANSCRIPT_VIEWER_SPACY_MODEL` | `de_core_news_sm` | Keep `sm` on Pi (memory limit). |
| `TRANSCRIPT_VIEWER_AUTH_SESSION_TTL_SECONDS` | `86400` | 24h session lifetime. |
| `TRANSCRIPT_VIEWER_CAST_TOKEN_TTL_SECONDS` | `10800` | 3h — must exceed longest episode. See `docs/CHROMECAST.md`. |
| `TRANSCRIPT_VIEWER_LOG_LEVEL` | `INFO` | `DEBUG`/`INFO`/`WARNING`/`ERROR`. |
| `TRANSCRIPT_VIEWER_LOG_FILE` | `/tmp/echoai.log` | Backs the `/logs` page. **Must stay under `/tmp`** — the container root filesystem is read-only. Empty disables file logging. |
| `TRANSCRIPT_VIEWER_LOG_MAX_BYTES` | `2000000` | Rotate at this size. |
| `TRANSCRIPT_VIEWER_LOG_BACKUP_COUNT` | `3` | Rotated files kept. Total disk ≈ `MAX_BYTES × (COUNT + 1)`. |

### 3.5 Copy `.env` to the Pi and lock it down
Fill in `.env` locally on Windows, then:
```powershell
scp .env pi@raspberrypi.local:/home/pi/echoai/.env
ssh pi@raspberrypi.local "chown pi:pi /home/pi/echoai/.env && chmod 600 /home/pi/echoai/.env"
```
`chmod 600` is required — `_validate_secrets()` and the pre-commit `.env`
scan will flag looser modes.

---

## 4) Copy `docker-compose.yml` and content

From the project root on Windows:
```powershell
scp docker-compose.yml pi@raspberrypi.local:/home/pi/echoai/
scp -r downloads\* pi@raspberrypi.local:/home/pi/echoai/downloads/
scp -r transcripts\* pi@raspberrypi.local:/home/pi/echoai/transcripts/
```
Both content directories are mounted **read-only** inside the container.

---

## 5) Start the stack

```powershell
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose pull && docker compose up -d"
```

Verify:
```powershell
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose ps"
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose logs --tail=100 echoai"
```
Look for `SECURITY:` warnings — any means a secret is weak, reused, or
missing. Rotate before going live.

Open: `https://echoai.innovisionlabs.co.uk/`

**The browser will show its own sign-in dialog before the page loads.** The app
shell is gated by HTTP Basic auth, so nothing renders until you authenticate;
after that a normal session cookie takes over and the page's API calls work
without re-entering credentials.

The one deliberate exception is `/?mode=receiver`, which the Chromecast fetches.
A TV has no cookie jar and cannot answer a Basic challenge, so that URL serves
the shell unauthenticated — safe, because the shell is static markup and every
API call the receiver then makes still needs a signed cast token.

---

## 6) Day-to-day operations (from Windows)

All commands are single-line `ssh` invocations so you can paste them straight
into PowerShell.

### Status & logs
```powershell
# Container status
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose ps"

# Tail live logs (Ctrl+C to exit)
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose logs -f echoai"

# Last 200 lines
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose logs --tail=200 echoai"

# Watchtower logs (image updates)
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose logs --tail=100 watchtower"
```

### The `/logs` page

The app has a built-in log viewer at `https://echoai.innovisionlabs.co.uk/logs`.
Prefer it over `docker compose logs` — it shows **both** server logs and logs
shipped from the browser and the Chromecast receiver, with filters for level,
source, and message text.

This is the only way to see what the Chromecast did: a TV has no DevTools, so
the receiver batches its own log lines to `POST /api/logs/client`, and they land
in the same file as the server's.

Access rules:
- `/logs` — the page shell is public (it contains no log data) and prompts for login, exactly like `/`.
- `GET /api/logs` — **session only**. A cast token is explicitly refused, because a token lives on a TV that anyone in the room can reach.
- `POST /api/logs/client` — accepts a cast token, so the receiver can ship logs. Entry count, message length, and level are all clamped server-side.

The log file itself:
```powershell
# Read it directly (it lives in the container's /tmp)
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose exec echoai cat /tmp/echoai.log"

# Just the errors
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose exec echoai grep ERROR /tmp/echoai.log"

# Check its size against the rotation cap
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose exec echoai ls -lh /tmp/"
```

> **Logs do not survive a restart.** `/tmp` is the only writable path in the
> container (the root filesystem is `read_only: true`), so a redeploy or reboot
> clears them. That is accepted — these are debugging logs, not an audit trail.

**Log volume is bounded in three places.** All three are already set in
`docker-compose.yml` / `.env.example`; check them if disk or memory looks wrong:

| Bound | Where | Default | Protects |
|---|---|---|---|
| App log rotation | `TRANSCRIPT_VIEWER_LOG_MAX_BYTES` × `_BACKUP_COUNT` | ~8 MB | The `/tmp` filesystem |
| `/tmp` size | `tmpfs: /tmp:size=64m` | 64 MB | **RAM** — tmpfs is memory and counts against `mem_limit: 512m` |
| Docker capture | `logging.options.max-size/max-file` | 30 MB | The **SD card** — the json-file driver is unbounded by default |

> The `/tmp` size cap matters more than it looks: tmpfs is RAM, not disk, so an
> unbounded `/tmp` lets a runaway writer consume the container's whole 512 MB
> and trigger an OOM kill.

Client log ingestion (`POST /api/logs/client`) is rate-limited to
`CLIENT_LOG_RATE_MAX_ENTRIES` per minute, so a misbehaving browser or receiver
cannot flood genuine evidence out of the rotation window.

To raise verbosity while chasing a bug, set `TRANSCRIPT_VIEWER_LOG_LEVEL=DEBUG`
in `.env` and restart — then put it back, since DEBUG fills the rotation window
much faster.

### Resource check
```powershell
ssh pi@raspberrypi.local "docker stats --no-stream"
ssh pi@raspberrypi.local "df -h /home && free -h"
```

### Restart / stop / start
```powershell
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose restart echoai"
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose down"
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose up -d"
```

### Manual image update
Normally Watchtower handles this. To force:
```powershell
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose pull && docker compose up -d"
```

### Rollback to a specific version
Edit the image tag in `docker-compose.yml` locally, then:
```powershell
scp docker-compose.yml pi@raspberrypi.local:/home/pi/echoai/
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose pull && docker compose up -d"
```

### Sync new content
```powershell
# Add new MP3s
scp downloads\*.mp3 pi@raspberrypi.local:/home/pi/echoai/downloads/

# Add new transcripts
scp transcripts\* pi@raspberrypi.local:/home/pi/echoai/transcripts/
```
No restart needed — the Flask app reads the directories on each request.

### Update `.env` (secret rotation, config change)
```powershell
scp .env pi@raspberrypi.local:/home/pi/echoai/.env
ssh pi@raspberrypi.local "chmod 600 /home/pi/echoai/.env && cd /home/pi/echoai && docker compose up -d"
```
Restart invalidates all in-memory sessions — every user re-logs in.

### Shell into the container (debug)
```powershell
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose exec echoai sh"
```
The filesystem is read-only except `/tmp` — expect writes elsewhere to fail.

### Reboot the Pi
```powershell
ssh pi@raspberrypi.local "sudo reboot"
```
Compose auto-starts on boot (`restart: unless-stopped`).

---

## 7) Security checklist (run after every deploy)

- [ ] `.env` is `chmod 600`, owner `pi:pi`
- [ ] `TRANSCRIPT_VIEWER_AUTH_DISABLED=0`
- [ ] `TRANSCRIPT_VIEWER_COOKIE_SECURE=1`
- [ ] `TRANSCRIPT_VIEWER_CAST_TOKEN_REQUIRED_FOR_MEDIA=1`
- [ ] `AUTH_PASSWORD`, `AUTH_SESSION_SECRET`, `CAST_SIGNING_KEY` are all set and mutually distinct
- [ ] No `SECURITY:` warnings in `docker compose logs echoai`
- [ ] Compose exposes `127.0.0.1:5000` only, not `0.0.0.0`
- [ ] `downloads/` and `transcripts/` are mounted `:ro`
- [ ] Container has `read_only: true`, `no-new-privileges`, `cap_drop: ALL`
- [ ] Memory 512M, PIDs 100 (defaults in `docker-compose.yml`)
- [ ] `GET /api/logs` returns 401 when signed out (log viewer is session-only)
- [ ] `TRANSCRIPT_VIEWER_LOG_FILE` is under `/tmp` — anywhere else fails on a read-only rootfs
- [ ] `GET /` returns 401 with a `WWW-Authenticate: Basic` header when signed out
- [ ] `GET /?mode=receiver` returns 200 — otherwise casting is broken
- [ ] `tmpfs: /tmp` has an explicit `size=` (tmpfs is RAM, counted against `mem_limit`)
- [ ] The `logging:` block is present on the service (Docker's default is unbounded)

---

## Notes

- Sessions are **in-memory** — any restart, redeploy, or Watchtower update logs everyone out.
- Watchtower polls GHCR and restarts the labeled `echoai` container when a new image is published from `main` (prod) or `develop` (dev).
- `/api/cast/debug` is authenticated — it exposes diagnostics; do not open it publicly.
- The container listens on `127.0.0.1:5000`. Public traffic must go through Cloudflare Tunnel, which terminates TLS.
- If `raspberrypi.local` doesn't resolve on your network, use the Pi's LAN IP: check with `ssh pi@raspberrypi.local "hostname -I"` once, then substitute.
