# The Python worker: the Codeforces mirror, the ability fit, the seeds.
#
# Built from the repo root so it can see nothing it doesn't need:
#   docker build -f worker/Dockerfile -t cp-worker .

FROM python:3.13-slim AS base
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# uv resolves and installs from the lockfile, same as on a laptop.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY worker/pyproject.toml worker/uv.lock* ./
RUN uv sync --frozen --no-dev || uv sync --no-dev

COPY worker/*.py ./
# worker/data (the usaco.guide clone) is deliberately absent: it is only read
# by the topic seed, which is a one-off run from a laptop against the same
# database. Shipping it would add megabytes to every deploy for a script that
# runs once a year.

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=4).status==200 else 1)"
# serve.py, not uvicorn's CLI: the bind must be dual-stack (Railway probes
# over IPv6, compose and the HEALTHCHECK above over IPv4) and asyncio forces
# IPV6_V6ONLY on any listener uvicorn opens itself — see worker/serve.py.
CMD ["python", "serve.py"]
