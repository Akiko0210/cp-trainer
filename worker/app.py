"""CP Trainer worker service.

Owns everything that talks to the Codeforces API in bulk (the Next app never
does) plus the analytics recompute. Endpoints are called by the Next app;
a background loop keeps every user's mirror fresh on an interval.

Run:  uv run uvicorn app:app --port 8787
Env:  DATABASE_URL, SYNC_INTERVAL_MINUTES (default 30), WORKER_PORT
"""

import asyncio
import contextlib
import logging
import os

from fastapi import BackgroundTasks, FastAPI, HTTPException

import cf_api
import db
import seed_cf
import seed_icpc
import seed_usaco
import sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("app")

SYNC_INTERVAL_MINUTES = int(os.environ.get("SYNC_INTERVAL_MINUTES", "30"))

# Serialize sync runs per user so a manual sync and the scheduler don't race.
_user_locks: dict[int, asyncio.Lock] = {}


def _lock_for(user_id: int) -> asyncio.Lock:
    return _user_locks.setdefault(user_id, asyncio.Lock())


async def _sync_user_safe(user_id: int, quick: bool = False) -> dict | None:
    async with _lock_for(user_id):
        try:
            with db.connect() as conn:
                return await sync.sync_user(conn, user_id, quick=quick)
        except Exception:
            log.exception("sync failed for user %s", user_id)
            return None


async def _scheduler() -> None:
    """Periodic passive mirror for all users (handoff §5)."""
    while True:
        await asyncio.sleep(SYNC_INTERVAL_MINUTES * 60)
        try:
            with db.connect() as conn, conn.cursor() as cur:
                cur.execute("select id from users where cf_handle is not null")
                ids = [r["id"] for r in cur.fetchall()]
            for uid in ids:
                await _sync_user_safe(uid)
        except Exception:
            log.exception("scheduler pass failed")


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_scheduler())
    yield
    task.cancel()


app = FastAPI(title="cp-trainer-worker", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/sync/{user_id}")
async def sync_endpoint(user_id: int, background: BackgroundTasks, quick: bool = False):
    """quick=true: small newest-page pull, awaited (solve view verdict check).
    quick=false: full incremental mirror, runs in background; the app polls
    sync_state for progress."""
    if quick:
        result = await _sync_user_safe(user_id, quick=True)
        if result is None:
            raise HTTPException(502, "sync failed — see worker logs / sync_state")
        return result
    background.add_task(_sync_user_safe, user_id, False)
    return {"started": True}


@app.post("/validate-handle/{handle}")
async def validate_handle(handle: str):
    """Check a CF handle exists before creating the user (onboarding)."""
    try:
        info = (await cf_api.call("user.info", handles=handle))[0]
    except cf_api.CFError:
        raise HTTPException(404, f"Codeforces doesn't know the handle “{handle}”")
    return {
        "handle": info["handle"],
        "rating": info.get("rating"),
        "maxRating": info.get("maxRating"),
        "rank": info.get("rank"),
    }


@app.post("/seed")
async def seed_endpoint(background: BackgroundTasks):
    """Re-runnable: usaco.guide topics/catalog, then CF problemset ratings."""

    async def run():
        with db.connect() as conn:
            seed_usaco.seed(conn)
            await seed_cf.seed_problemset(conn)

    background.add_task(run)
    return {"started": True}


@app.post("/seed-icpc")
async def seed_icpc_endpoint(background: BackgroundTasks, limit: int | None = None):
    """Re-runnable ICPC set ingest from open.kattis.com.

    Archival content that changes about once a year, so this is user-triggered
    (Settings -> Refresh ICPC sets) rather than scheduled. Kattis has no API and
    disallows profile scraping, so there is nothing here to monitor continuously.
    """

    def run():
        with db.connect() as conn:
            try:
                result = seed_icpc.seed(conn, limit=limit)
                log.info("icpc seed complete: %s", result)
            except Exception:
                log.exception("icpc seed failed")

    background.add_task(run)
    return {"started": True}
