"""Fast solve detection for duels and guild contests ("the arena").

The scheduler mirrors everyone every 30 minutes, which is uselessly slow for
"whoever solves it first wins". This loop watches only the people currently in
an active duel or contest, one newest-page user.status fetch per person per
pass, through the same rate-limited queue as everything else — so a duel adds
two polite requests every pass, not a second traffic stream.

Dormancy is the design constraint, not an optimisation: a scale-to-zero
database bills on "is anything connected", and an always-on 10-second poll
would keep it awake around the clock for a feature nobody is using at 4am.
So the loop only exists while something is live. The Next app POSTs
/arena/poke when a duel goes active or a contest starts; the loop runs until
nothing active remains, then parks itself. A worker restart mid-duel recovers
because app.py pokes once at boot.

Submissions are written through sync.write_page — the same batched, idempotent
upsert the mirror uses — and NEVER touch sync_state: the cursor only advances
on a complete walk (see sync._persist_cursor), and a newest-page peek is
exactly the incomplete walk that rule exists for.
"""

import asyncio
import logging
import os

import cf_api
import db
import sync
from seed_cf import tag_topic_ids

log = logging.getLogger("arena")

POLL_INTERVAL_S = float(os.environ.get("ARENA_POLL_SECONDS", "10"))
# Newest page only. A duel or contest submission is by definition seconds old;
# anything deeper is the scheduler's job.
PAGE_SIZE = 25

_task: asyncio.Task | None = None


def poke() -> bool:
    """Ensure the loop is running. Returns True if this call started it."""
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())
        return True
    return False


def shutdown() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        _task = None


async def _loop() -> None:
    log.info("arena loop up")
    try:
        while True:
            with db.connect() as conn:
                active = await _pass(conn)
            if not active:
                log.info("arena idle — loop parked, database may sleep")
                return
            await asyncio.sleep(POLL_INTERVAL_S)
    except asyncio.CancelledError:
        raise
    except Exception:
        # The next poke (accept/start/boot) restarts it; dying silently would
        # leave a duel that looks live and never resolves.
        log.exception("arena loop died; it will restart on the next poke")


async def _pass(conn) -> bool:
    """One sweep + poll + settle. Returns True while anything stays active."""
    _sweep(conn)

    with conn.cursor() as cur:
        cur.execute(
            """
            select distinct u.id, u.cf_handle from users u
            where u.cf_handle is not null and (
              exists (select 1 from duels d
                      where d.status = 'active'
                        and u.id in (d.challenger_id, d.opponent_id))
              or exists (select 1 from guild_contest_players gp
                         join guild_contests c on c.id = gp.contest_id
                         where c.status = 'active' and gp.user_id = u.id))
            """
        )
        watchers = cur.fetchall()
    if not watchers:
        return False

    topic_ids = tag_topic_ids(conn)
    for w in watchers:
        try:
            subs = await cf_api.call(
                "user.status", handle=w["cf_handle"], **{"from": 1, "count": PAGE_SIZE}
            )
        except Exception:
            # One handle failing (CF hiccup, renamed account) must not stall
            # the rest of the field.
            log.exception("arena poll failed for %s", w["cf_handle"])
            continue
        with conn.cursor() as cur:
            if subs:
                sync.write_page(cur, w["id"], subs, topic_ids)
        conn.commit()

    _settle_duels(conn)
    return True


def _sweep(conn) -> None:
    """Time-based state transitions, all idempotent.

    The app runs the same sweeps lazily on its own read/write paths, so a dead
    worker degrades to 'slow', never to 'stuck forever'."""
    with conn.cursor() as cur:
        cur.execute(
            "update duels set status = 'expired' "
            "where status = 'pending' and expires_at < now()"
        )
        cur.execute(
            """
            update duels set status = 'finished', finish_reason = 'timeout',
                             finished_at = now()
            where status = 'active' and deadline_at < now()
            """
        )
        cur.execute(
            """
            update guild_contests set status = 'finished', finished_at = now()
            where status = 'active' and ends_at < now()
            """
        )
    conn.commit()


def _settle_duels(conn) -> None:
    """Declare winners from the mirror.

    The race is decided on the judge's own clock (submitted_at), tie-broken by
    CF submission id — never on when this loop happened to fetch, which would
    make the winner depend on polling order."""
    with conn.cursor() as cur:
        cur.execute(
            """
            update duels d set
              status = 'finished', finish_reason = 'solve',
              winner_id = w.user_id, winning_submitted_at = w.submitted_at,
              finished_at = now()
            from (
              select distinct on (d2.id)
                     d2.id, s.user_id, s.submitted_at
              from duels d2
              join submissions s on s.problem_id = d2.problem_id
                and s.user_id in (d2.challenger_id, d2.opponent_id)
                and s.verdict = 'OK'
                and s.submitted_at >= d2.started_at
                and s.submitted_at <= d2.deadline_at
              where d2.status = 'active'
              order by d2.id, s.submitted_at, s.external_submission_id
            ) w
            where d.id = w.id and d.status = 'active'
            """
        )
    conn.commit()
