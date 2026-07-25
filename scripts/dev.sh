#!/usr/bin/env bash
# Bring up the whole stack for local dev: Postgres (Docker), the Python
# sync worker, and the Next.js app. Ctrl-C stops the worker + app
# (Postgres keeps running; `docker stop cp-trainer-pg` if you want it down).
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm db >/dev/null
until docker exec cp-trainer-pg pg_isready -U cp -q 2>/dev/null; do sleep 0.5; done
echo "postgres ready on :5488"

(cd worker && exec uv run uvicorn app:app --port 8787) &
WORKER_PID=$!
trap 'kill $WORKER_PID 2>/dev/null' EXIT

pnpm dev
