# Raspberry Pi Production Deployment

## Goal
Deploy the transcript viewer as a production Docker service on Raspberry Pi using the published image and Watchtower auto-updates.

## 1) Prerequisites
- Raspberry Pi OS with Docker + Docker Compose plugin installed.
- A GitHub Personal Access Token (PAT) with `read:packages` scope.
- This project's `docker-compose.yml` copied to the Pi.

## 2) Configure Pi host paths
Your `docker-compose.yml` expects:
- `/home/pi/.docker/config.json` for GHCR auth (Watchtower)
- project folder with:
  - `./downloads`
  - `./transcripts`
  - `./.env`

Create the data folders on the Pi:
```bash
mkdir -p /home/pi/echoai/downloads /home/pi/echoai/transcripts
```

## 3) Configure environment

Copy `.env.example` (or create `.env`) with **strong, unique** values for every secret.

### Required secrets
| Variable | Requirements |
|---|---|
| `TRANSCRIPT_VIEWER_AUTH_USERNAME` | Your login username |
| `TRANSCRIPT_VIEWER_AUTH_PASSWORD` | **≥ 16 characters**, random |
| `TRANSCRIPT_VIEWER_AUTH_SESSION_SECRET` | **≥ 64 hex chars** — generate with `python -c "import secrets; print(secrets.token_hex(32))"` |
| `TRANSCRIPT_VIEWER_CAST_SIGNING_KEY` | **≥ 64 hex chars**, different from session secret — generate with `python -c "import secrets; print(secrets.token_hex(32))"` |

### Security settings for production
```dotenv
# Lock down cookies for HTTPS (Cloudflare terminates TLS)
TRANSCRIPT_VIEWER_COOKIE_SECURE=1

# Require signed token for Cast media requests
TRANSCRIPT_VIEWER_CAST_TOKEN_REQUIRED_FOR_MEDIA=1

# Auth must be enabled in production
TRANSCRIPT_VIEWER_AUTH_DISABLED=0
```

> **Critical:** Each secret (`AUTH_PASSWORD`, `AUTH_SESSION_SECRET`, `CAST_SIGNING_KEY`) must be **independent** — never reuse one as another. The server logs warnings at startup if it detects weak or reused secrets.

### Generate strong secrets (run on any machine with Python)
```powershell
python -c "import secrets; print('AUTH_PASSWORD:', secrets.token_urlsafe(20))"
python -c "import secrets; print('AUTH_SESSION_SECRET:', secrets.token_hex(32))"
python -c "import secrets; print('CAST_SIGNING_KEY:', secrets.token_hex(32))"
```

## 4) Secure the .env file

After copying `.env` to the Pi, restrict permissions so only the `pi` user can read it:

```bash
chown pi:pi /home/pi/echoai/.env
chmod 600 /home/pi/echoai/.env
```

> Docker Compose reads `.env` as the `pi` user. The container receives values via environment injection — it never mounts the file.

## 5) Login to GHCR on Pi

```bash
echo <GITHUB_PAT> | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin
```

This writes `/home/pi/.docker/config.json` for Watchtower to use.

## 6) Deploy service

From your Windows machine (PowerShell), copy config and data:
```powershell
scp C:\Users\mnste\PycharmProjects\easygerman\docker-compose.yml pi@raspberrypi.local:/home/pi/echoai/
scp C:\Users\mnste\PycharmProjects\easygerman\.env pi@raspberrypi.local:/home/pi/echoai/
scp -r C:\Users\mnste\PycharmProjects\easygerman\downloads\* pi@raspberrypi.local:/home/pi/echoai/downloads/
scp -r C:\Users\mnste\PycharmProjects\easygerman\transcripts\* pi@raspberrypi.local:/home/pi/echoai/transcripts/
```

Secure `.env` on the Pi:
```bash
ssh pi@raspberrypi.local "chown pi:pi /home/pi/echoai/.env && chmod 600 /home/pi/echoai/.env"
```

Start the stack:
```bash
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose pull && docker compose up -d"
```

## 7) Verify runtime

```bash
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose ps"
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose logs --tail=100 echoai"
```

Check for any `SECURITY:` warnings in the logs — these indicate weak or reused secrets that must be rotated.

Open in browser: `https://echoai.innovisionlabs.co.uk/`

## 8) Security checklist for production

Run through this checklist after every deployment:

- [ ] `.env` has `chmod 600` — only `pi` user can read
- [ ] `TRANSCRIPT_VIEWER_AUTH_DISABLED=0` — auth is enforced
- [ ] `TRANSCRIPT_VIEWER_COOKIE_SECURE=1` — cookies only over HTTPS
- [ ] `TRANSCRIPT_VIEWER_CAST_TOKEN_REQUIRED_FOR_MEDIA=1` — media requires auth
- [ ] All three secrets are **unique**, **≥ 16 chars** (password) / **≥ 64 hex chars** (keys)
- [ ] No `SECURITY:` warnings in `docker compose logs`
- [ ] Port `5000` is bound to `127.0.0.1` (not exposed externally — Cloudflare tunnel handles access)
- [ ] Data volumes are mounted read-only (`:ro` in docker-compose.yml)
- [ ] Container runs as non-root (`appuser`)
- [ ] `read_only: true`, `no-new-privileges`, `cap_drop: ALL` are set

## 9) Secret rotation

If any secret is compromised or was ever committed to git:

1. Generate new values (see section 3)
2. Update `.env` on the Pi
3. Restart: `docker compose restart echoai`
4. All existing sessions are invalidated immediately (they're in-memory)

## 10) Update/rollback operations

Update to latest image:
```bash
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose pull && docker compose up -d"
```

Restart only app service:
```bash
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose restart echoai"
```

Stop stack:
```bash
ssh pi@raspberrypi.local "cd /home/pi/echoai && docker compose down"
```

## Notes
- Watchtower (if running) auto-updates labeled containers when new images are pushed.
- The `/api/cast/debug` endpoint requires authentication — it exposes server diagnostics.
- Port binding is `127.0.0.1:5000` — direct external access is blocked. Use Cloudflare Tunnel for public access.
- Container memory is capped at 512 MB and 100 PIDs to prevent resource exhaustion.
