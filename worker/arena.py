"""Fast solve detection for the arena: duels (classic and bullet), guild
contests, and battles.

The scheduler mirrors everyone every 30 minutes, which is uselessly slow for
"whoever solves it first wins". This loop watches only the people currently in
a live race — an active duel, contest, or battle *match* — one newest-page
user.status fetch per person per pass, through the same rate-limited queue as
everything else. So a duel adds two polite requests every pass, not a second
traffic stream; a battle adds two per match in progress, and nobody queued or
idle costs a request at all.

Dormancy is the design constraint, not an optimisation: a scale-to-zero
database bills on "is anything connected", and an always-on poll would keep it
awake around the clock for a feature nobody is using at 4am. So the loop has
three states:

  * live     — something is being raced: poll, settle, sleep a few seconds.
  * dormant  — nothing is being raced, but a battle is scheduled or an active
               battle has nobody in a match: hold NO connection and sleep
               until the next moment the clock matters (a start, a bell) or
               until the app pokes (someone queued, a battle was created,
               cancelled or started early).
  * parked   — nothing at all: the task ends; the next poke restarts it.

The Next app POSTs /arena/poke on every one of those events; a worker restart
recovers because app.py pokes once at boot.

Bullet duels tighten the sleep (ARENA_BULLET_POLL_SECONDS) because a
five-minute race can't wait ten seconds between looks — but the floor is the
CF lock, 2.2s per watched player per pass, and nothing here can go under it.
Bullet players are polled first so the tighter cadence is honoured before a
big battle's field.

Submissions are written through sync.write_page — the same batched, idempotent
upsert the mirror uses — and NEVER touch sync_state: the cursor only advances
on a complete walk (see sync._persist_cursor), and a newest-page peek is
exactly the incomplete walk that rule exists for.

Every decision is SQL. Winners are read off the judge's own clock
(submitted_at, tie-broken by CF submission id), never off when this loop
happened to fetch; the clock-driven transitions live in arena_sweep() in the
schema, shared with the app's lazy per-request sweep; and matchmaking is one
statement, run only here — serve.py guarantees a single process, so there is
exactly one matchmaker.
"""

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone

import cf_api
import db
import sync
from seed_cf import tag_topic_ids

log = logging.getLogger("arena")

POLL_INTERVAL_S = float(os.environ.get("ARENA_POLL_SECONDS", "10"))
# While a bullet duel is live. Trims only the sleep between passes; each pass
# still spends 2.2s per watched player on the CF lock.
BULLET_POLL_INTERVAL_S = float(os.environ.get("ARENA_BULLET_POLL_SECONDS", "2"))
# A dormant loop re-evaluates at least this often, in case a poke was lost
# (the worker was restarting while a battle was being created).
MAX_PARK_S = 6 * 3600
# Newest page only. A duel or contest submission is by definition seconds old;
# anything deeper is the scheduler's job.
PAGE_SIZE = 25

_task: asyncio.Task | None = None
# Set by poke(); the loop waits on it — dormant until the next clock event,
# live between passes — so a queue click or a "check now" is acted on now.
_wake = asyncio.Event()
# Players a poke asked to have polled first in the next pass. Drained at the
# top of that pass.
_first: set[int] = set()


@dataclass
class Status:
    """What one pass found: is anything being raced, is any of it bullet, and
    when is the next moment the clock matters if nothing is."""

    live: bool
    bullet: bool
    next_wake: datetime | None


def poke(first: int | None = None) -> bool:
    """Ensure the loop is running and make it re-evaluate now — a dormant
    loop wakes, a live one skips the rest of its sleep. `first` is a user to
    poll ahead of the field in that pass. Returns True if this call started
    the loop."""
    global _task
    if first is not None:
        _first.add(int(first))
    _wake.set()
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
            # Cleared before the pass, so a poke that lands during it is not
            # lost: the wait below returns immediately and we go again.
            _wake.clear()
            with db.connect() as conn:
                st = await _pass(conn)
            if st.live:
                # Interruptible: a poke during the sleep ends it. The CF lock
                # still meters every call, so a hammered poke costs at most
                # back-to-back passes at 2.2s per watched player.
                try:
                    await asyncio.wait_for(
                        _wake.wait(),
                        timeout=BULLET_POLL_INTERVAL_S if st.bullet else POLL_INTERVAL_S,
                    )
                except TimeoutError:
                    pass
                continue
            if st.next_wake is None:
                log.info("arena idle — loop parked, database may sleep")
                return
            wait = (st.next_wake - datetime.now(timezone.utc)).total_seconds()
            # Never a tight loop: the sweep has just run, so a wake in the
            # past means clock skew, not work to do.
            wait = min(MAX_PARK_S, max(1.0, wait))
            log.info(
                "arena dormant for %.0fs (until %s) — no connection held",
                wait,
                st.next_wake.isoformat(timespec="seconds"),
            )
            try:
                await asyncio.wait_for(_wake.wait(), timeout=wait)
            except TimeoutError:
                pass
    except asyncio.CancelledError:
        raise
    except Exception:
        # The next poke (accept/start/queue/boot) restarts it; dying silently
        # would leave a duel that looks live and never resolves.
        log.exception("arena loop died; it will restart on the next poke")


async def _pass(conn) -> Status:
    """One sweep + matchmake + poll + settle. Returns what to do next."""
    _sweep(conn)
    # After the sweep: a battle that just went active has everyone queued.
    _matchmake(conn)

    watchers = _watchers(conn)
    if _first:
        # Whoever asked to be checked goes first; the rest keep their order.
        asked = _first.copy()
        _first.clear()
        watchers.sort(key=lambda w: 0 if w["id"] in asked else 1)
    if watchers:
        topic_ids = tag_topic_ids(conn)
        for w in watchers:
            try:
                subs = await cf_api.call(
                    "user.status", handle=w["cf_handle"], **{"from": 1, "count": PAGE_SIZE}
                )
            except Exception:
                # One handle failing (CF hiccup, renamed account) must not
                # stall the rest of the field.
                log.exception("arena poll failed for %s", w["cf_handle"])
                continue
            with conn.cursor() as cur:
                if subs:
                    sync.write_page(cur, w["id"], subs, topic_ids)
            conn.commit()

        _settle_duels(conn)
        _settle_bullet(conn)
        _settle_battles(conn)
        # A match that just settled may have ended a closing battle, and a
        # bullet duel may have run out of problems: land that now, not next
        # pass.
        _sweep(conn)

    return _status(conn)


def _watchers(conn) -> list[dict]:
    """Everyone in a live race with a handle to poll. Bullet players first."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select u.id, u.cf_handle,
                   coalesce(bool_or(d.mode = 'bullet'), false) as bullet
              from users u
              left join duels d
                on d.status = 'active' and u.id in (d.challenger_id, d.opponent_id)
              left join guild_contest_players gp on gp.user_id = u.id
              left join guild_contests c
                on c.id = gp.contest_id and c.status = 'active'
              left join battle_matches m
                on m.status = 'active' and u.id in (m.a_id, m.b_id)
             where u.cf_handle is not null
               and (d.id is not null or c.id is not null or m.id is not null)
             group by u.id, u.cf_handle
             order by bullet desc, u.id
            """
        )
        return cur.fetchall()


def _status(conn) -> Status:
    with conn.cursor() as cur:
        cur.execute(
            """
            select
              exists (select 1 from duels where status = 'active')            as duel,
              exists (select 1 from duels
                       where status = 'active' and mode = 'bullet')           as bullet,
              exists (select 1 from guild_contests where status = 'active')   as contest,
              exists (select 1 from battle_matches where status = 'active')   as match,
              (select min(t) from (
                 select starts_at as t from battles where status = 'scheduled'
                 union all
                 select ends_at   as t from battles where status = 'active') w) as next_wake
            """
        )
        row = cur.fetchone()
    return Status(
        live=bool(row["duel"] or row["contest"] or row["match"]),
        bullet=bool(row["bullet"]),
        next_wake=row["next_wake"],
    )


def _sweep(conn) -> None:
    """Every clock-driven transition — arena_sweep() in the schema, shared
    with the app's lazy per-request sweep so the two can never disagree."""
    with conn.cursor() as cur:
        cur.execute("select arena_sweep(null::bigint)")
    conn.commit()


def _settle_duels(conn) -> None:
    """Declare classic duel winners from the mirror.

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
              where d2.status = 'active' and d2.mode = 'classic'
              order by d2.id, s.submitted_at, s.external_submission_id
            ) w
            where d.id = w.id and d.status = 'active'
            """
        )
    conn.commit()


def _settle_bullet(conn) -> None:
    """Close the round in play on its first OK and open the next one.

    Same rule as classic: the judge's clock, tie-broken by submission id.
    Close and open commit together so nobody ever sees "round over, nothing to
    solve". bullet_open_round returns 0 when the catalog has nothing left for
    this pair, and the duel then ends on points."""
    with conn.cursor() as cur:
        cur.execute(
            """
            update duel_rounds r
               set winner_id = w.user_id, won_at = w.submitted_at, closed_at = now()
              from (
                select distinct on (r2.duel_id)
                       r2.duel_id, r2.round_no, s.user_id, s.submitted_at
                  from duel_rounds r2
                  join duels d on d.id = r2.duel_id
                   and d.status = 'active' and d.mode = 'bullet'
                  join submissions s on s.problem_id = r2.problem_id
                   and s.user_id in (d.challenger_id, d.opponent_id)
                   and s.verdict = 'OK'
                   and s.submitted_at >= r2.opened_at
                   and s.submitted_at <= d.deadline_at
                 where r2.closed_at is null
                 order by r2.duel_id, s.submitted_at, s.external_submission_id
              ) w
             where r.duel_id = w.duel_id and r.round_no = w.round_no
               and r.closed_at is null
            """
        )
        # Also the safety net for a duel the app activated but never got to
        # open round one for (it died between the two).
        cur.execute(
            """
            select d.id, bullet_open_round(d.id) as round_no
              from duels d
             where d.status = 'active' and d.mode = 'bullet' and d.deadline_at > now()
               and not exists (select 1 from duel_rounds r
                                where r.duel_id = d.id and r.closed_at is null)
            """
        )
        exhausted = [row["id"] for row in cur.fetchall() if row["round_no"] == 0]
        for did in exhausted:
            log.info("bullet duel %s: no unseen problem left — ending on points", did)
            cur.execute("select bullet_finish(%s)", (did,))
    conn.commit()


def _settle_battles(conn) -> None:
    """First OK in an active match wins it; battle_settle_match promotes the
    winner, frees both players, and applies the knockout rule."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select battle_settle_match(w.id, 'solve', w.user_id, w.submitted_at)
              from (
                select distinct on (m.id) m.id, s.user_id, s.submitted_at
                  from battle_matches m
                  join submissions s on s.problem_id = m.problem_id
                   and s.user_id in (m.a_id, m.b_id)
                   and s.verdict = 'OK'
                   and s.submitted_at >= m.started_at
                   and s.submitted_at <= m.deadline_at
                 where m.status = 'active'
                 order by m.id, s.submitted_at, s.external_submission_id
              ) w
            """
        )
    conn.commit()


def _matchmake(conn) -> None:
    """Pair queued players, same tier only, in queue order — one statement.

    Consecutive queued players in a tier become a pair; an odd one out stays
    queued. Each pair gets a problem at the tier's rating that neither has
    touched and that no match in this battle has used (two matches sharing a
    problem would be two matches sharing answers). A pair with no such problem
    is left queued and marked, so the room can say why. The `state = 'queued'`
    guard on the final update is what makes "one active match per player"
    hold; the partial unique indexes on battle_matches catch anything else."""
    with conn.cursor() as cur:
        cur.execute(
            """
            with cand as (
              select p.battle_id, p.user_id, p.tier,
                     b.tier_base, b.tier_step, b.match_duration_s,
                     row_number() over (partition by p.battle_id, p.tier
                                        order by p.queued_at, p.user_id) as rn
                from battle_players p
                join battles b on b.id = p.battle_id and b.status = 'active'
                join users u on u.id = p.user_id and u.cf_handle is not null
               where p.state = 'queued'
            ),
            pairs as (
              select a.battle_id, a.tier, a.user_id as a_id, b.user_id as b_id,
                     a.match_duration_s,
                     least(3500, a.tier_base + (a.tier - 1) * a.tier_step) as target
                from cand a
                join cand b on b.battle_id = a.battle_id and b.tier = a.tier
                           and b.rn = a.rn + 1
               where mod(a.rn, 2) = 1
            ),
            picked as (
              select p.*,
                     arena_pick_problem(
                       array[p.a_id, p.b_id], p.target,
                       (select coalesce(array_agg(m.problem_id), '{}')
                          from battle_matches m where m.battle_id = p.battle_id)
                     ) as problem_id
                from pairs p
            ),
            ins as (
              insert into battle_matches
                (battle_id, tier, target_rating, a_id, b_id, problem_id, deadline_at)
              select distinct on (battle_id, problem_id)
                     battle_id, tier, target, a_id, b_id, problem_id,
                     now() + make_interval(secs => match_duration_s)
                from picked
               where problem_id is not null
              returning id, battle_id, a_id, b_id
            ),
            failed as (
              update battle_players p set pick_failed_at = now()
                from picked f
               where f.problem_id is null
                 and p.battle_id = f.battle_id and p.user_id in (f.a_id, f.b_id)
            )
            update battle_players p
               set state = 'matched', current_match_id = ins.id,
                   queued_at = null, pick_failed_at = null
              from ins
             where p.battle_id = ins.battle_id
               and p.user_id in (ins.a_id, ins.b_id)
               and p.state = 'queued'
            """
        )
        if cur.rowcount:
            log.info("matchmaker paired %d player(s)", cur.rowcount)
    conn.commit()
