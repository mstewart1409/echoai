# ---------------------------------------------------------------------------
# echoai — Podcast Transcript Viewer
# ---------------------------------------------------------------------------
# Multi-stage build: install dependencies, then copy into slim runtime.
# ---------------------------------------------------------------------------

# Pin to digest for supply chain protection (ghcr.io/astral-sh/uv:python3.14-bookworm-slim).
# To refresh: docker buildx imagetools inspect ghcr.io/astral-sh/uv:python3.14-bookworm-slim
FROM ghcr.io/astral-sh/uv@sha256:7cf77f594be8042dab6daa9fe326f90962252268b4f120a7f5dccce4d947e6c1 AS builder

WORKDIR /app

# Build dependencies for compiled packages
RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer caching)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Copy source (includes echoai/viewer/ static assets) and install the project
COPY echoai/ echoai/
COPY README.md ./
RUN uv sync --frozen --no-dev

# Download spaCy language model
ARG SPACY_MODEL=de_core_news_sm
RUN uv run python -m ensurepip --upgrade \
    && uv run python -m spacy download ${SPACY_MODEL}

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
# Pin to digest for supply chain protection (python:3.14-slim-bookworm).
# To refresh: docker buildx imagetools inspect python:3.14-slim-bookworm
FROM python@sha256:55e465cb7e50cd1d7217fcb5386aa87d0356ca2cd790872142ef68d9ef6812b4 AS runtime

# Create a non-root application user
RUN useradd -r -s /bin/false appuser

WORKDIR /app

# Copy the virtual environment and source from builder
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/echoai /app/echoai

# Build metadata (set via --build-arg)
ARG BUILD_ID=""
ARG BUILD_TIMESTAMP=""
ARG GIT_BRANCH=""
ENV BUILD_ID=${BUILD_ID} \
    BUILD_TIMESTAMP=${BUILD_TIMESTAMP} \
    GIT_BRANCH=${GIT_BRANCH} \
    PYTHONUNBUFFERED=1 \
    TRANSCRIPT_VIEWER_DOWNLOADS_DIR=/app/downloads \
    TRANSCRIPT_VIEWER_TRANSCRIPTS_DIR=/app/transcripts \
    TRANSCRIPT_VIEWER_STATIC_DIR=/app/echoai/viewer \
    TRANSCRIPT_VIEWER_PORT=5000 \
    PATH="/app/.venv/bin:$PATH"

# Persistent data (downloads, transcripts) — mount host volumes here
VOLUME /app/downloads
VOLUME /app/transcripts
RUN mkdir -p /app/downloads /app/transcripts \
    && chown appuser:appuser /app/downloads /app/transcripts

# Entrypoint script: restrict file permissions, then exec app
# - umask 077: all new files created by the app are owner-only (600/700)
# - chmod 700: restrict mounted data directories
# - exec: proper PID 1 handoff for signal handling
RUN printf '#!/bin/sh\numask 077\nchmod 700 /app/downloads 2>/dev/null || true\nchmod 700 /app/transcripts 2>/dev/null || true\nexec python -m echoai.transcript_viewer\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh

# Map viewer server port
EXPOSE 5000

# Run as non-root
USER appuser

ENTRYPOINT ["/app/entrypoint.sh"]
