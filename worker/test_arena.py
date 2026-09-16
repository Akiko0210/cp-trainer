"""Checks for the arena's game rules: bullet rounds, battle matchmaking, the
knockout, and the clocks.

No pytest — the worker has no test dependency and this is a script like the
rest of them. Point it at a scratch database (the schema, including
db/migrations/006_battles.sql, must be applied) and run it:

    DATABASE_URL='postgresql://…/scratch' uv run python test_arena.py

Nothing here touches Codeforces: every rule under test is SQL that takes a
connection, so the fixture writes mirror rows directly and calls the same
functions the loop calls. It creates a throwaway guild, six users and a
private slice of catalog under a contest id Codeforces cannot issue, and
deletes all of it on the way out. Exits non-zero if any check failed.

What it guards:

  * The picker never hands out a problem either player has touched, honours
    the exclusion list, and reports exhaustion as null rather than erroring.
  * A bullet round is won on the judge's clock, tie-broken by submission id;
    the next round opens in the same pass at start + step·(k−1); the bell is
    decided on POINTS (sum of problem ratings), not on rounds won.
  * The matchmaker pairs the same tier only, in queue order, leaves the odd
    one out queued, and never pairs across tiers.
  * A solve promotes exactly the winner; a timeout is a tie; both sides are
    freed either way.
  * The knockout: alone at the bottom tier is out, it cascades, and one player
    left ends the battle with a champion.
  * The clocks: a scheduled battle opens with everyone queued in join order,
    fewer than two players cancels it, the bell closes it, and closing ends
    once the last match settles.
  * The inbox (007): every duel transition writes exactly the rows it should,
    to exactly the people it should, once — and a withdrawal writes none.
"""

import asyncio
import logging
import os
import sys
from datetime import datetime, timedelta, timezone

import arena
import db

logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(message)s")

# One Codeforces cannot issue (see test_sync.py for why that matters).
CONTEST_ID = 999_000_002
HANDLE_PREFIX = "__test_arena_"
SLUG = "__test-arena__"
FAILURES: list[str] = []


# --- assertions -------------------------------------------------------------


def check(label: str, got, want) -> None:
    if got == want:
        print(f"  ok   {label}: {got}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        FAILURES.append(label)


def check_true(label: str, cond: bool) -> None:
    check(label, bool(cond), True)


# --- fixtures ---------------------------------------------------------------


def setup(conn) -> dict:
    """A guild, six linked members, and catalog rows at every rating the
    ladders below will ask for."""
    teardown(conn)
    with conn.cursor() as cur:
        cur.execute(
            "insert into guilds (slug, name, invite_code) values (%s, %s, %s) returning id",
            (SLUG, "arena test", "ARENATEST"),
        )
        gid = cur.fetchone()["id"]
        users = []
        for i in range(1, 7):
            cur.execute(
                "insert into users (cf_handle, display_name, guild_id, guild_role)"
                " values (%s, %s, %s, 'member') returning id",
                (f"{HANDLE_PREFIX}{i}__", f"player {i}", gid),
            )
            users.append(cur.fetchone()["id"])
        problems: dict[int, int] = {}
        for rating in [*range(800, 2100, 100), 3000, 3500]:
            cur.execute(
                "insert into problem_catalog (source, external_id, title, url,"
                " contest_id, rating) values ('cf', %s, %s, %s, %s, %s) returning id",
                (
                    f"{CONTEST_ID}R{rating}",
                    f"Rated {rating}",
                    f"https://example.invalid/{CONTEST_ID}/{rating}",
                    CONTEST_ID,
                    rating,
                ),
            )
            problems[rating] = cur.fetchone()["id"]
    conn.commit()
    return {"guild": gid, "users": users, "problems": problems}


def teardown(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "select id from users where cf_handle like %s", (f"{HANDLE_PREFIX}%",)
        )
        ids = [r["id"] for r in cur.fetchall()]
        if ids:
            cur.execute("delete from battles where guild_id in (select id from guilds where slug = %s)", (SLUG,))
            cur.execute("delete from notifications where user_id = any(%s)", (ids,))
            cur.execute("delete from duels where challenger_id = any(%s) or opponent_id = any(%s)", (ids, ids))
            cur.execute("delete from submissions where user_id = any(%s)", (ids,))
            cur.execute("delete from users where id = any(%s)", (ids,))
        cur.execute("delete from guilds where slug = %s", (SLUG,))
        cur.execute("delete from problem_catalog where contest_id = %s", (CONTEST_ID,))
    conn.commit()


_sub_id = [10_000_000]


def submit(conn, user_id: int, problem_id: int, at: datetime, verdict: str = "OK",
           sub_id: int | None = None) -> None:
    """One mirror row, as sync.write_page would have written it."""
    _sub_id[0] += 1
    with conn.cursor() as cur:
        cur.execute(
            "insert into submissions (user_id, problem_id, verdict, submitted_at,"
            " source, external_submission_id) values (%s, %s, %s, %s, 'cf_api', %s)",
            (user_id, problem_id, verdict, at, sub_id or _sub_id[0]),
        )
    conn.commit()


def now() -> datetime:
    return datetime.now(timezone.utc)


def row(conn, sql: str, *params):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


def rows(conn, sql: str, *params):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def run(conn, sql: str, *params) -> None:
    with conn.cursor() as cur:
        cur.execute(sql, params)
    conn.commit()


def outside_fixture(conn) -> list[int]:
    """Every catalog id NOT in the fixture — passed as the exclusion list so a
    seeded scratch database still gives deterministic picks."""
    return [r["id"] for r in rows(
        conn, "select id from problem_catalog where contest_id is distinct from %s", CONTEST_ID
    )]


# --- the tests --------------------------------------------------------------


def test_picker(conn, fx) -> None:
    print("picker")
    u1, u2 = fx["users"][:2]
    P = fx["problems"]
    excl = outside_fixture(conn)
    by_id = {v: k for k, v in P.items()}

    picks = {
        row(conn, "select arena_pick_problem(%s::bigint[], 1000, %s::bigint[]) as id",
            [u1, u2], excl)["id"]
        for _ in range(12)
    }
    check_true("picks sit in the first band (850–1150)",
               picks and all(850 <= by_id[p] <= 1150 for p in picks))

    # Any submission — even a wrong one — marks a problem as seen.
    submit(conn, u1, P[1000], now(), verdict="WRONG_ANSWER")
    submit(conn, u2, P[1100], now(), verdict="OK")
    picks = {
        row(conn, "select arena_pick_problem(%s::bigint[], 1000, %s::bigint[]) as id",
            [u1, u2], excl)["id"]
        for _ in range(12)
    }
    check("only the untouched 900 is left in band", picks, {P[900]})

    # Exclusion list on top of that: nothing left in ±150, so the band widens
    # to ±300 and 800, 1200 and 1300 come into reach.
    picks = {
        row(conn, "select arena_pick_problem(%s::bigint[], 1000, %s::bigint[]) as id",
            [u1, u2], excl + [P[900]])["id"]
        for _ in range(24)
    }
    check("widened band, exclusions honoured", picks, {P[800], P[1200], P[1300]})

    every = excl + list(P.values())
    check("exhausted catalog picks null",
          row(conn, "select arena_pick_problem(%s::bigint[], 1000, %s::bigint[]) as id",
              [u1, u2], every)["id"], None)
    run(conn, "delete from submissions where user_id in (%s, %s)", u1, u2)


def make_bullet(conn, fx, challenger: int, opponent: int, start=1000, step=100,
                duration_s=600) -> int:
    r = row(
        conn,
        "insert into duels (guild_id, challenger_id, opponent_id, expires_at, mode,"
        " duration_s, bullet_start_rating, bullet_step)"
        " values (%s, %s, %s, now() + interval '5 minutes', 'bullet', %s, %s, %s)"
        " returning id",
        fx["guild"], challenger, opponent, duration_s, start, step,
    )
    conn.commit()
    return r["id"]


def test_bullet_rounds(conn, fx) -> None:
    print("bullet: accept, round advance, tie-break")
    u1, u2 = fx["users"][:2]
    did = make_bullet(conn, fx, u1, u2)

    check("accept by a stranger is null",
          row(conn, "select bullet_accept(%s, %s) as r", did, fx["users"][2])["r"], None)
    check("accept by the opponent starts it",
          row(conn, "select bullet_accept(%s, %s) as r", did, u2)["r"], 1)
    conn.commit()
    check("second accept is null (already started)",
          row(conn, "select bullet_accept(%s, %s) as r", did, u2)["r"], None)
    d = row(conn, "select status, started_at, deadline_at from duels where id = %s", did)
    check("duel active", d["status"], "active")
    check_true("deadline is the chosen clock",
               abs((d["deadline_at"] - d["started_at"]).total_seconds() - 600) < 2)
    r1 = row(conn, "select r.*, p.rating from duel_rounds r join problem_catalog p on p.id = r.problem_id"
                   " where duel_id = %s and round_no = 1", did)
    check("round 1 target is the start", r1["target_rating"], 1000)
    check("round 1 points are the problem's rating", r1["points"], r1["rating"])
    check_true("round 1 rating within the first band", 850 <= r1["rating"] <= 1150)

    # Opening again while a round is in play is a no-op.
    check("open_round with a round in play is null",
          row(conn, "select bullet_open_round(%s) as r", did)["r"], None)
    conn.commit()

    # u2 solves round 1; u1's later AC on the same problem changes nothing.
    t = now()
    submit(conn, u2, r1["problem_id"], t)
    submit(conn, u1, r1["problem_id"], t + timedelta(seconds=3))
    arena._settle_bullet(conn)
    r1 = row(conn, "select * from duel_rounds where duel_id = %s and round_no = 1", did)
    check("round 1 closed", r1["closed_at"] is not None, True)
    check("round 1 to the first AC", r1["winner_id"], u2)
    check("won_at is the judge's clock", r1["won_at"], t)
    r2 = row(conn, "select * from duel_rounds where duel_id = %s and round_no = 2", did)
    check_true("round 2 opened in the same pass", r2 is not None)
    check("round 2 target is start + step", r2["target_rating"], 1100)
    check("round 2 is a different problem", r2["problem_id"] != r1["problem_id"], True)
    check("round 2 still in play", r2["closed_at"], None)

    # Same instant: the lower submission id wins (CF numbers them in order).
    t = now()
    submit(conn, u1, r2["problem_id"], t, sub_id=20_000_002)
    submit(conn, u2, r2["problem_id"], t, sub_id=20_000_001)
    arena._settle_bullet(conn)
    r2 = row(conn, "select * from duel_rounds where duel_id = %s and round_no = 2", did)
    check("same second: lower submission id takes it", r2["winner_id"], u2)
    check("round 3 opened", row(conn, "select count(*) as n from duel_rounds where duel_id = %s", did)["n"], 3)
    check("duel still active", row(conn, "select status from duels where id = %s", did)["status"], "active")
    run(conn, "delete from duels where id = %s", did)
    run(conn, "delete from submissions where user_id in (%s, %s)", u1, u2)


def test_bullet_bell(conn, fx) -> None:
    print("bullet: the bell is decided on points")
    u1, u2 = fx["users"][:2]
    P = fx["problems"]

    def scenario(rounds, expect_winner, label):
        did = make_bullet(conn, fx, u1, u2)
        run(conn, "update duels set status = 'active', started_at = now() - interval '11 minutes',"
                  " deadline_at = now() - interval '1 second' where id = %s", did)
        for n, (winner, pts) in enumerate(rounds, start=1):
            run(conn, "insert into duel_rounds (duel_id, round_no, problem_id, target_rating, points,"
                      " winner_id, won_at, closed_at)"
                      " values (%s, %s, %s, %s, %s, %s, now(), now())",
                did, n, P[800 + 100 * (n - 1)], 1000, pts, winner)
        # A round in play at the bell closes unwon.
        run(conn, "insert into duel_rounds (duel_id, round_no, problem_id, target_rating, points)"
                  " values (%s, %s, %s, 1000, 1500)", did, len(rounds) + 1, P[2000])
        arena._sweep(conn)
        d = row(conn, "select status, finish_reason, winner_id from duels where id = %s", did)
        check(f"{label}: finished at the bell", (d["status"], d["finish_reason"]), ("finished", "timeout"))
        check(f"{label}: winner", d["winner_id"], expect_winner)
        check(f"{label}: open round closed",
              row(conn, "select count(*) as n from duel_rounds where duel_id = %s and closed_at is null", did)["n"], 0)
        run(conn, "delete from duels where id = %s", did)

    # u1 took ONE round worth 1400; u2 took TWO rounds worth 800 + 500.
    # Rounds won says u2, points say u1 — points it is.
    scenario([(u2, 800), (u1, 1400), (u2, 500)], u1, "more points, fewer rounds")
    scenario([(u1, 1000), (u2, 1000)], None, "equal points is a draw")
    scenario([], None, "nothing scored is a draw")


def test_bullet_exhausted(conn, fx) -> None:
    print("bullet: catalog runs dry mid-duel")
    u5, u6 = fx["users"][4:6]
    # u5 has touched every rated CF problem there is: nothing can be picked.
    run(conn, "insert into submissions (user_id, problem_id, verdict, submitted_at, source,"
              " external_submission_id)"
              " select %s, id, 'OK', now(), 'manual', 30000000 + id from problem_catalog"
              " where source = 'cf' and active and contest_id is not null", u5)
    did = make_bullet(conn, fx, u5, u6)
    check("accept with nothing to pick returns 0",
          row(conn, "select bullet_accept(%s, %s) as r", did, u6)["r"], 0)
    conn.commit()
    check("duel stays pending", row(conn, "select status from duels where id = %s", did)["status"], "pending")
    # Now the dry case mid-duel: active with a round in play, then exhausted.
    run(conn, "update duels set status = 'active', started_at = now(),"
              " deadline_at = now() + interval '10 minutes' where id = %s", did)
    run(conn, "insert into duel_rounds (duel_id, round_no, problem_id, target_rating, points,"
              " winner_id, won_at, closed_at) values (%s, 1, %s, 1000, 1200, %s, now(), now())",
        did, fx["problems"][1200], u6)
    arena._settle_bullet(conn)
    d = row(conn, "select status, finish_reason, winner_id from duels where id = %s", did)
    check("ends on points when nothing is left", (d["status"], d["finish_reason"], d["winner_id"]),
          ("finished", "timeout", u6))
    run(conn, "delete from duels where id = %s", did)
    run(conn, "delete from submissions where user_id = %s", u5)


def make_battle(conn, fx, players: list[int], *, status="scheduled", starts_in_s=-1,
                duration_s=3600, tier_base=1000, tier_step=200) -> int:
    r = row(
        conn,
        "insert into battles (guild_id, host_id, name, status, max_players, tier_base,"
        " tier_step, duration_s, starts_at, ends_at)"
        " values (%s, %s, 'test battle', %s, 64, %s, %s, %s,"
        "         now() + make_interval(secs => %s),"
        "         now() + make_interval(secs => %s) + make_interval(secs => %s))"
        " returning id",
        fx["guild"], players[0], status, tier_base, tier_step, duration_s,
        starts_in_s, starts_in_s, duration_s,
    )
    bid = r["id"]
    for i, uid in enumerate(players):
        run(conn, "insert into battle_players (battle_id, user_id, joined_at)"
                  " values (%s, %s, now() - interval '1 minute' + make_interval(secs => %s))",
            bid, uid, i)
    return bid


def players_of(conn, bid: int) -> dict:
    return {r["user_id"]: r for r in rows(
        conn, "select * from battle_players where battle_id = %s", bid)}


def matches_of(conn, bid: int, status: str | None = None) -> list:
    return rows(conn, "select * from battle_matches where battle_id = %s"
                      + (" and status = %s" if status else "") + " order by id",
                *([bid, status] if status else [bid]))


def queue(conn, bid: int, *uids: int) -> None:
    for uid in uids:
        run(conn, "update battle_players set state = 'queued', queued_at = clock_timestamp()"
                  " where battle_id = %s and user_id = %s and state = 'idle'", bid, uid)


def test_battle_start_and_matchmaking(conn, fx) -> None:
    print("battle: start, matchmaking, settle, timeout, same tier only")
    u1, u2, u3, u4 = fx["users"][:4]
    bid = make_battle(conn, fx, [u1, u2, u3, u4])

    arena._sweep(conn)
    b = row(conn, "select status, started_at from battles where id = %s", bid)
    check("scheduled battle opened", b["status"], "active")
    check_true("started_at stamped", b["started_at"] is not None)
    ps = players_of(conn, bid)
    check("everyone queued at the start", {p["state"] for p in ps.values()}, {"queued"})
    check("queued in join order", all(ps[u]["queued_at"] == ps[u]["joined_at"] for u in ps), True)

    arena._matchmake(conn)
    ms = matches_of(conn, bid, "active")
    check("two matches from four", len(ms), 2)
    check("paired in join order", [(m["a_id"], m["b_id"]) for m in ms], [(u1, u2), (u3, u4)])
    check("played at tier 1", {m["tier"] for m in ms}, {1})
    check("at the tier's rating", {m["target_rating"] for m in ms}, {1000})
    check("no shared problem", len({m["problem_id"] for m in ms}), 2)
    check_true("30-minute clock",
               all(abs((m["deadline_at"] - m["started_at"]).total_seconds() - 1800) < 2 for m in ms))
    ps = players_of(conn, bid)
    check("players matched", {p["state"] for p in ps.values()}, {"matched"})
    check("current_match_id set", all(p["current_match_id"] for p in ps.values()), True)

    # Idempotent: a second run pairs nobody.
    arena._matchmake(conn)
    check("matchmaker is idempotent", len(matches_of(conn, bid)), 2)

    # u1 solves; u2's later AC is irrelevant.
    m1, m2 = ms
    t = now()
    submit(conn, u1, m1["problem_id"], t)
    submit(conn, u2, m1["problem_id"], t + timedelta(seconds=1))
    arena._settle_battles(conn)
    m1 = row(conn, "select * from battle_matches where id = %s", m1["id"])
    check("match 1 solved", (m1["status"], m1["finish_reason"], m1["winner_id"]), ("finished", "solve", u1))
    check("winning_submitted_at is the judge's clock", m1["winning_submitted_at"], t)
    ps = players_of(conn, bid)
    check("winner climbs", (ps[u1]["tier"], ps[u1]["wins"], ps[u1]["state"]), (2, 1, "idle"))
    check("loser stays", (ps[u2]["tier"], ps[u2]["losses"], ps[u2]["state"]), (1, 1, "idle"))
    check("both freed", (ps[u1]["current_match_id"], ps[u2]["current_match_id"]), (None, None))
    check("nobody eliminated yet (tier 1 still has three)",
          [u for u, p in ps.items() if p["state"] == "eliminated"], [])

    # Match 2 runs out of time: a tie.
    run(conn, "update battle_matches set deadline_at = now() - interval '1 second' where id = %s", m2["id"])
    arena._sweep(conn)
    m2 = row(conn, "select * from battle_matches where id = %s", m2["id"])
    check("match 2 timed out", (m2["status"], m2["finish_reason"], m2["winner_id"]), ("finished", "timeout", None))
    ps = players_of(conn, bid)
    check("tie: both stay, both idle",
          [(ps[u]["tier"], ps[u]["draws"], ps[u]["state"]) for u in (u3, u4)],
          [(1, 1, "idle"), (1, 1, "idle")])

    # Same tier only: u1 (tier 2) and u2 (tier 1) queued together pair with nobody.
    queue(conn, bid, u1, u2)
    arena._matchmake(conn)
    check("no cross-tier pairing", len(matches_of(conn, bid, "active")), 0)
    ps = players_of(conn, bid)
    check("both still queued", (ps[u1]["state"], ps[u2]["state"]), ("queued", "queued"))

    # Queue order and the odd one out: tier 1 now has u2 < u3 < u4.
    queue(conn, bid, u3, u4)
    arena._matchmake(conn)
    ms = matches_of(conn, bid, "active")
    check("one pair from three at tier 1", [(m["a_id"], m["b_id"]) for m in ms], [(u2, u3)])
    ps = players_of(conn, bid)
    check("odd one out stays queued", ps[u4]["state"], "queued")
    check("lone tier-2 player stays queued", ps[u1]["state"], "queued")

    # Problems never repeat inside a battle.
    used = [m["problem_id"] for m in matches_of(conn, bid)]
    check("no problem reused in the battle", len(used), len(set(used)))

    run(conn, "delete from battles where id = %s", bid)
    run(conn, "delete from submissions where user_id in (%s, %s)", u1, u2)


def test_knockout(conn, fx) -> None:
    print("battle: the knockout rule")
    u1, u2, u3, u4 = fx["users"][:4]

    # Alone at the bottom after a loss.
    bid = make_battle(conn, fx, [u1, u2, u3, u4], status="active")
    run(conn, "update battle_players set tier = 2 where battle_id = %s and user_id in (%s, %s)", bid, u1, u3)
    queue(conn, bid, u2, u4)
    arena._matchmake(conn)
    m = matches_of(conn, bid, "active")[0]
    submit(conn, u2, m["problem_id"], now())
    arena._settle_battles(conn)
    ps = players_of(conn, bid)
    check("loser alone at tier 1 is out", (ps[u4]["state"], ps[u4]["tier"]), ("eliminated", 1))
    check_true("eliminated_at stamped", ps[u4]["eliminated_at"] is not None)
    check("the rest are in", [ps[u]["state"] for u in (u1, u2, u3)], ["idle"] * 3)
    check("battle continues", row(conn, "select status from battles where id = %s", bid)["status"], "active")
    check("an eliminated player can't be queued by the matchmaker",
          row(conn, "select count(*) as n from battle_players where battle_id = %s and state = 'queued'", bid)["n"], 0)
    run(conn, "delete from battles where id = %s", bid)
    run(conn, "delete from submissions where user_id = %s", u2)

    # The cascade: tiers 1, 2, 3, 3 → the loners at 1 and then 2 are out.
    bid = make_battle(conn, fx, [u1, u2, u3, u4], status="active")
    run(conn, "update battle_players set tier = case user_id when %s then 1 when %s then 2 else 3 end"
              " where battle_id = %s", u1, u2, bid)
    run(conn, "select battle_eliminate(%s)", bid)
    ps = players_of(conn, bid)
    check("cascade: tier-1 loner out", ps[u1]["state"], "eliminated")
    check("cascade: then the tier-2 loner", ps[u2]["state"], "eliminated")
    check("cascade stops at a tier with two", [ps[u]["state"] for u in (u3, u4)], ["idle", "idle"])
    check("still active with two left", row(conn, "select status from battles where id = %s", bid)["status"], "active")

    # Last player standing: u3 beats u4 → u4 alone at 3 → out → u3 champion.
    queue(conn, bid, u3, u4)
    arena._matchmake(conn)
    m = matches_of(conn, bid, "active")[0]
    submit(conn, u3, m["problem_id"], now())
    arena._settle_battles(conn)
    b = row(conn, "select status, champion_id, finished_at from battles where id = %s", bid)
    check("one left ends it early", (b["status"], b["champion_id"]), ("finished", u3))
    check_true("finished_at stamped", b["finished_at"] is not None)
    ps = players_of(conn, bid)
    check("runner-up eliminated", ps[u4]["state"], "eliminated")
    check("champion at tier 4", ps[u3]["tier"], 4)
    run(conn, "delete from battles where id = %s", bid)
    run(conn, "delete from submissions where user_id = %s", u3)


def test_battle_clocks(conn, fx) -> None:
    print("battle: understaffed start, closing, finish, queue purge")
    u1, u2, u3, u4 = fx["users"][:4]

    bid = make_battle(conn, fx, [u1])
    arena._sweep(conn)
    check("one player at the start is cancelled",
          row(conn, "select status from battles where id = %s", bid)["status"], "cancelled")
    run(conn, "delete from battles where id = %s", bid)

    bid = make_battle(conn, fx, [u1, u2, u3, u4], status="active")
    queue(conn, bid, u1, u2)
    arena._matchmake(conn)
    queue(conn, bid, u3)
    run(conn, "update battles set ends_at = now() - interval '1 second' where id = %s", bid)
    arena._sweep(conn)
    b = row(conn, "select status from battles where id = %s", bid)
    check("the bell: closing while a match runs", b["status"], "closing")
    ps = players_of(conn, bid)
    check("queue purged at the bell", ps[u3]["state"], "idle")
    check("the running match is untouched", len(matches_of(conn, bid, "active")), 1)
    arena._matchmake(conn)
    check("no new matches while closing", len(matches_of(conn, bid)), 1)

    m = matches_of(conn, bid, "active")[0]
    submit(conn, u2, m["problem_id"], now())
    arena._settle_battles(conn)
    arena._sweep(conn)
    b = row(conn, "select status, champion_id from battles where id = %s", bid)
    check("last match settled: finished", b["status"], "finished")
    check("champion is the ladder's top", b["champion_id"], u2)
    run(conn, "delete from battles where id = %s", bid)
    run(conn, "delete from submissions where user_id = %s", u2)


def test_status(conn, fx) -> None:
    print("loop status")
    u1, u2 = fx["users"][:2]
    bid = make_battle(conn, fx, [u1, u2], starts_in_s=3600)
    st = arena._status(conn)
    starts_at = row(conn, "select starts_at from battles where id = %s", bid)["starts_at"]
    check_true("a scheduled battle sets a wake no later than its start",
               st.next_wake is not None and st.next_wake <= starts_at)
    run(conn, "update battles set status = 'active', starts_at = now() where id = %s", bid)
    st = arena._status(conn)
    check("active battle with nobody matched is not live (may sleep)", st.live, False)
    queue(conn, bid, u1, u2)
    arena._matchmake(conn)
    st = arena._status(conn)
    check("a running match is live", st.live, True)
    check("no bullet duel: normal cadence", st.bullet, False)
    did = make_bullet(conn, fx, fx["users"][2], fx["users"][3])
    run(conn, "update duels set status = 'active', started_at = now(),"
              " deadline_at = now() + interval '5 minutes' where id = %s", did)
    st = arena._status(conn)
    check("a live bullet duel tightens the cadence", st.bullet, True)
    check("bullet players are polled first",
          arena._watchers(conn)[0]["id"] in (fx["users"][2], fx["users"][3]), True)
    check("only matched battle players are watched",
          sorted(w["id"] for w in arena._watchers(conn)),
          sorted([u1, u2, fx["users"][2], fx["users"][3]]))
    run(conn, "delete from duels where id = %s", did)
    run(conn, "delete from battles where id = %s", bid)


def inbox(conn, uid: int, did: int) -> list[str]:
    return [r["kind"] for r in rows(
        conn, "select kind from notifications where user_id = %s and duel_id = %s order by id",
        uid, did)]


def test_inbox(conn, fx) -> None:
    print("inbox: who is told what, once")
    u1, u2 = fx["users"][:2]

    did = make_bullet(conn, fx, u1, u2)
    check("challenge: the opponent has a row", inbox(conn, u2, did), ["duel_challenge"])
    check("challenge: the challenger has none", inbox(conn, u1, did), [])
    r = row(conn, "select actor_id, payload from notifications where user_id = %s and duel_id = %s", u2, did)
    check("challenge: actor is the challenger", r["actor_id"], u1)
    check("challenge: payload carries the ladder",
          (r["payload"]["mode"], r["payload"]["duration_s"], r["payload"]["bullet_step"]),
          ("bullet", 600, 100))

    row(conn, "select bullet_accept(%s, %s) as r", did, u2)
    conn.commit()
    check("accept: the challenger is told", inbox(conn, u1, did), ["duel_accepted"])
    # The same transition again (a re-run of an idempotent statement) adds
    # nothing: the WHEN guard and the unique index both stand in the way.
    run(conn, "update duels set status = 'active' where id = %s", did)
    check("a no-op status write adds nothing", inbox(conn, u1, did), ["duel_accepted"])
    run(conn, "insert into notifications (user_id, guild_id, kind, duel_id, actor_id)"
              " values (%s, %s, 'duel_accepted', %s, %s) on conflict do nothing",
        u1, fx["guild"], did, u2)
    check("a duplicate row is refused by the index", inbox(conn, u1, did), ["duel_accepted"])

    run(conn, "insert into duel_rounds (duel_id, round_no, problem_id, target_rating, points,"
              " winner_id, won_at, closed_at) values (%s, 9, %s, 1000, 1300, %s, now(), now())",
        did, fx["problems"][1300], u2)
    run(conn, "update duels set status = 'finished', finish_reason = 'forfeit', winner_id = %s,"
              " finished_at = now() where id = %s", u2, did)
    check("finish: both are told", (inbox(conn, u1, did)[-1], inbox(conn, u2, did)[-1]),
          ("duel_finished", "duel_finished"))
    r = row(conn, "select payload from notifications where user_id = %s and duel_id = %s"
                  " and kind = 'duel_finished'", u1, did)
    check("finish: payload has the winner and the points",
          (r["payload"]["winner_id"], r["payload"]["finish_reason"],
           r["payload"]["challenger_points"], r["payload"]["opponent_points"]),
          (u2, "forfeit", 0, 1300))
    run(conn, "delete from duels where id = %s", did)

    did = make_bullet(conn, fx, u1, u2)
    run(conn, "update duels set status = 'declined' where id = %s", did)
    check("decline: the challenger is told", inbox(conn, u1, did), ["duel_declined"])
    run(conn, "delete from duels where id = %s", did)

    did = make_bullet(conn, fx, u1, u2)
    run(conn, "update duels set status = 'cancelled' where id = %s", did)
    check("withdraw: nobody gets a new row",
          (inbox(conn, u1, did), inbox(conn, u2, did)), ([], ["duel_challenge"]))
    run(conn, "delete from duels where id = %s", did)

    did = make_bullet(conn, fx, u1, u2)
    run(conn, "update duels set expires_at = now() - interval '1 second' where id = %s", did)
    arena._sweep(conn)
    check("expiry by the sweep: the challenger is told", inbox(conn, u1, did), ["duel_expired"])
    check("expiry: the opponent's challenge row still stands (status comes from the join)",
          inbox(conn, u2, did), ["duel_challenge"])
    run(conn, "delete from duels where id = %s", did)
    check("deleting the duel cascades to its rows",
          row(conn, "select count(*) as n from notifications where duel_id = %s", did)["n"], 0)


# --- runner -----------------------------------------------------------------


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL is not set — point this at a scratch database")
        return 2

    with db.connect() as conn:
        fx = setup(conn)
        try:
            test_picker(conn, fx)
            test_bullet_rounds(conn, fx)
            test_bullet_bell(conn, fx)
            test_bullet_exhausted(conn, fx)
            test_battle_start_and_matchmaking(conn, fx)
            test_knockout(conn, fx)
            test_battle_clocks(conn, fx)
            test_status(conn, fx)
            test_inbox(conn, fx)
        finally:
            conn.rollback()
            teardown(conn)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
