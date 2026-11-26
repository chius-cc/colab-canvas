# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend-builder

WORKDIR /build/frontend

RUN npm install -g pnpm@12.14.0

COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend/ ./
RUN pnpm build


FROM python:3.12-slim AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-client \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY backend/pyproject.toml /tmp/backend/pyproject.toml
COPY backend/app /tmp/backend/app
RUN pip install --no-cache-dir /tmp/backend \
    && rm -rf /tmp/backend

COPY backend/app /app/app
COPY workflows /app/workflows
COPY scripts /app/scripts
COPY --from=frontend-builder /build/frontend/dist /app/frontend/dist

RUN groupadd --gid 1000 canvas \
    && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/canvas --shell /bin/bash canvas \
    && mkdir -p /data \
    && chown -R canvas:canvas /data /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CANVAS_DATA_DIR=/data \
    WORKFLOWS_DIR=/app/workflows \
    SCRIPTS_DIR=/app/scripts \
    FRONTEND_DIST_DIR=/app/frontend/dist

USER canvas

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; r = urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3); sys.exit(0 if r.status == 200 else 1)"]

CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
