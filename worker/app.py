"""CP Trainer worker service.

Owns everything that talks to the Codeforces API in bulk (the Next app never
does) plus the analytics recompute. Endpoints are called by the Next app;
a background loop keeps every user's mirror fresh on an interval.

Run:  uv run uvicorn app:app --port 8787
Env:  DATABASE_URL, SYNC_INTERVAL_MINUTES (default 30),
      CONTEST_REFRESH_MINUTES (default 360), ARENA_POLL_SECONDS (default 10),
      WORKER_PORT, WORKER_TOKEN (shared with the Next app; required outside
      localhost)
"""

import asyncio
import contextlib
import json
import logging
import os
import secrets

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse

import arena
import broadcast
import cf_api
import contests
import db
import seed_cf
import seed_icpc
import seed_usaco
import sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("app")

SYNC_INTERVAL_MINUTES = int(os.environ.get("SYNC_INTERVAL_MINUTES", "30"))
# The contest calendar changes a few times a week; the browser counts down from
# the stored start time, so refreshing this often buys nothing.
CONTEST_REFRESH_MINUTES = int(os.environ.get("CONTEST_REFRESH_MINUTES", "360"))

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


async def _contest_loop() -> None:
    """Keep the upcoming-contest mirror fresh (worker/contests.py).

    Refreshes immediately at boot — unlike the sync scheduler, which sleeps
    first, because a fresh install should show the calendar on the first page
    load rather than after the first interval.
    """
    while True:
        try:
            with db.connect() as conn:
                n = await contests.refresh(conn)
            log.info("contest refresh: %s upcoming", n)
        except Exception:
            log.exception("contest refresh failed")
        await asyncio.sleep(CONTEST_REFRESH_MINUTES * 60)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = [asyncio.create_task(_scheduler()), asyncio.create_task(_contest_loop())]
    # One boot-time poke so a duel or contest that was live when the worker
    # restarted resumes detection; if nothing is active the loop parks itself
    # after a single cheap query.
    arena.poke()
    yield
    for task in tasks:
        task.cancel()
    arena.shutdown()
    broadcast.broadcaster.shutdown()


app = FastAPI(title="cp-trainer-worker", lifespan=lifespan)

WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "").strip()


def require_token(x_worker_token: str = Header(default="")) -> None:
    """Shared-secret gate on everything that acts.

    These endpoints re-sync any user's full Codeforces history and crawl
    Kattis, so reaching the worker must not be the same thing as being allowed
    to drive it. With no token configured the worker is assumed to be on a
    private network (a laptop, or a platform's internal address) and stays
    open — that is the localhost development case, and the Next app refuses to
    boot in production without WORKER_TOKEN set on both sides.
    """
    if not WORKER_TOKEN:
        return
    if not secrets.compare_digest(x_worker_token, WORKER_TOKEN):
        raise HTTPException(401, "Bad or missing worker token")


@app.get("/health")
def health() -> dict:
    """Unauthenticated on purpose: platform health checks can't hold a secret,
    and this reveals nothing."""
    return {"ok": True}


@app.get("/stream")
async def stream(token: str = ""):
    """The live leaderboard, streamed from the process that never gets cut.

    Browsers connect here directly (EventSource, cross-origin), not through
    the Next app — a serverless host caps a response's duration, which is why
    the old stream blinked every 60 seconds. Auth is a token the Next app
    mints for its signed-in members (HMAC over WORKER_TOKEN, carrying the
    guild id and an expiry) because the session cookie doesn't cross origins.
    Events are filtered to the token's guild before they leave this process.
    """
    try:
        claims = broadcast.verify_stream_token(token, WORKER_TOKEN)
    except broadcast.TokenError as e:
        raise HTTPException(401, str(e))
    guild_id = int(claims["g"])

    async def gen():
        q = await broadcast.broadcaster.register(guild_id)
        try:
            yield f"event: ready\ndata: {json.dumps({'guild_id': guild_id})}\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=25)
                    yield f"event: standings\ndata: {json.dumps(ev)}\n\n"
                except TimeoutError:
                    # Comment-only heartbeat: keeps intermediaries from
                    # reaping an idle connection, and is also how a vanished
                    # client is finally noticed (the write fails).
                    yield ": ping\n\n"
        finally:
            broadcast.broadcaster.unregister(q, guild_id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            # Wide open on purpose: the gate is the token, not the origin —
            # tokens are minted only for signed-in members, scoped to a guild
            # and expiring. Pinning an origin here would break the moment the
            # app moved and protect nothing the token doesn't.
            "Access-Control-Allow-Origin": "*",
        },
    )


@app.post("/sync/{user_id}", dependencies=[Depends(require_token)])
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


@app.post("/arena/poke", dependencies=[Depends(require_token)])
async def arena_poke():
    """Wake the arena loop (worker/arena.py). The Next app calls this when a
    duel goes active or a guild contest starts; the loop parks itself again
    once nothing active remains, so poking an idle worker is nearly free."""
    return {"started": arena.poke()}


@app.post("/validate-handle/{handle}", dependencies=[Depends(require_token)])
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


@app.post("/seed", dependencies=[Depends(require_token)])
async def seed_endpoint(background: BackgroundTasks):
    """Re-runnable: usaco.guide topics/catalog, then CF problemset ratings."""

    async def run():
        with db.connect() as conn:
            seed_usaco.seed(conn)
            await seed_cf.seed_problemset(conn)

    background.add_task(run)
    return {"started": True}


@app.post("/seed-icpc", dependencies=[Depends(require_token)])
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
