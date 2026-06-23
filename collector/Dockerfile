# jvmScout collector + React dashboard. Build context must be the repo root so
# both collector/ and frontend/ are available.
#   docker build -f collector/Dockerfile -t jvmscout-collector .
#
# Stage 1 builds the React SPA; stage 2 runs the collector and serves the build.

# ---------- Stage 1: build the React dashboard ----------
FROM node:22-slim AS ui-build
WORKDIR /app/frontend

# Install deps first for layer caching. --legacy-peer-deps because the Lovable
# stack pins some peers ahead of their ecosystem (React 19 / zod 4 / vite 8).
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

COPY frontend/ ./
RUN npm run build
# -> /app/frontend/dist/client (static SPA: _shell.html + assets/)

# ---------- Stage 2: collector runtime ----------
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/collector/src \
    COLLECTOR_HOST=0.0.0.0 \
    COLLECTOR_PORT=8080 \
    COLLECTOR_DB_URL=sqlite+aiosqlite:////data/collector.db \
    COLLECTOR_UI_DIR=/app/ui

WORKDIR /app/collector

# Dependencies first for layer caching.
COPY collector/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt

# Collector code, plus the SPA built in stage 1.
COPY collector/ /app/collector/
COPY --from=ui-build /app/frontend/dist/client/ /app/ui/

# Run as a non-root user; /data holds the SQLite database (mount a volume here).
RUN useradd -u 10001 -m appuser \
    && mkdir -p /data \
    && chown -R appuser /data /app
USER appuser

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz').status==200 else 1)"

# Apply DB migrations, then start the collector. `alembic upgrade head` is
# idempotent and works against SQLite or Postgres (COLLECTOR_DB_URL).
CMD ["sh", "-c", "python -m alembic upgrade head && python -m collector"]
