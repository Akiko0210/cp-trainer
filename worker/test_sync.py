"""End-to-end checks for the Codeforces sync page loop.

No pytest — the worker has no test dependency and this is a script like the rest
of them. Point it at a scratch database and run it:

    DATABASE_URL='postgresql://…/scratch' uv run python test_sync.py

It creates its own tables' worth of rows under a throwaway handle, stubs
`cf_api.call` so nothing touches Codeforces, and drops what it made on the way
out. Exits non-zero on the first failed assertion.

What it is guarding, in order of how expensive each was to learn:

  * **Statements per page.** The whole point of batching. A page costs three
    statements regardless of size; the old loop cost about four *per
    submission*, which at 86ms per round trip to a hosted Postgres made a first
    sync take 20 minutes and get killed by the 15-minute Actions cap.
  * **The newest-first trap.** Codeforces returns submissions newest-first, so
    a cursor advanced mid-walk points at the newest id in the account and the
    next run stops immediately, never fetching the older pages. A killed walk
    must leave the cursor where it was, and must still keep its committed rows.
  * **Idempotency and the verdict upsert.** Re-running a sync is how every retry
    works, and TESTING -> OK has to land on the existing row rather than a new
    one.
  * **Repeated problems in one page.** `on conflict do update` refuses to touch
    the same row twice in one statement, and a page of submissions names the
    same problem over and over.
"""

import asyncio
import logging
import os
import sys

import cf_api
import db
import seed_cf
import sync

logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(message)s")

HANDLE = "__test_sync_handle__"
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


# --- a fake Codeforces account ----------------------------------------------

# Two problems, so a page names the same problem more than once — that is the
# case that breaks a naive multi-row `on conflict do update`.
PROBLEMS = {
    "A": {
        "contestId": 1700,
        "index": "A",
        "name": "Alpha",
        "rating": 800,
        "tags": ["greedy", "math"],
    },
    "B": {
        "contestId": 1700,
        "index": "B",
        "name": "Beta",
        "rating": 1200,
        "tags": ["dp"],
    },
}


def account(n: int, verdicts: dict[int, str] | None = None) -> list[dict]:
    """`n` submissions, newest first, as user.status returns them."""
    verdicts = verdicts or {}
    subs = []
    for i in range(n, 0, -1):
        key = "A" if i % 2 else "B"
        subs.append(
            {
                "id": 1000 + i,
                "problem": PROBLEMS[key],
                "verdict": verdicts.get(1000 + i, "OK" if i % 3 else "WRONG_ANSWER"),
                "programmingLanguage": "GNU C++20",
                "creationTimeSeconds": 1_700_000_000 + i * 60,
                "timeConsumedMillis": 30 + i,
                "memoryConsumedBytes": 1024 * i,
                "author": {"participantType": "PRACTICE"},
            }
        )
    return subs


class FakeCF:
    """Stands in for cf_api.call. `fail_on_page` raises to simulate a kill."""

    def __init__(self, subs: list[dict], fail_on_page: int | None = None):
        self.subs = subs
        self.fail_on_page = fail_on_page
        self.status_calls = 0

    async def call(self, method: str, **params):
        if method == "user.info":
            return [{"rating": 1500, "maxRating": 1600, "rank": "specialist"}]
        if method != "user.status":
            raise AssertionError(f"unexpected CF method {method}")
        self.status_calls += 1
        if self.fail_on_page == self.status_calls:
            raise RuntimeError("simulated kill mid-walk")
        start, count = params["from"], params["count"]
        return self.subs[start - 1 : start - 1 + count]


def install(fake: FakeCF) -> FakeCF:
    cf_api.call = fake.call
    return fake


# --- statement counting -----------------------------------------------------


class CountingCursor:
    """Forwards to a real cursor, counting execute() calls."""

    def __init__(self, inner):
        self._inner = inner
        self.n = 0

    def execute(self, *a, **kw):
        self.n += 1
        return self._inner.execute(*a, **kw)

    def __getattr__(self, name):
        return getattr(self._inner, name)


# --- fixtures ---------------------------------------------------------------


def setup(conn) -> int:
    """A throwaway user, plus the topics the CF tag mapping needs."""
    with conn.cursor() as cur:
        cur.execute(
            "delete from submissions where user_id in"
            " (select id from users where cf_handle = %s)",
            (HANDLE,),
        )
        cur.execute(
            "delete from sync_state where user_id in"
            " (select id from users where cf_handle = %s)",
            (HANDLE,),
        )
        cur.execute(
            "delete from topic_mastery where user_id in"
            " (select id from users where cf_handle = %s)",
            (HANDLE,),
        )
        cur.execute("delete from users where cf_handle = %s", (HANDLE,))
        cur.execute(
            "insert into users (cf_handle, display_name) values (%s, %s) returning id",
            (HANDLE, "sync test"),
        )
        user_id = cur.fetchone()["id"]

        # Every slug the mapping names, so tag_topic_ids doesn't warn about the
        # ones this fixture happens not to use.
        for slug in sorted(set(seed_cf.CF_TAG_TO_MODULE.values())):
            cur.execute(
                "insert into topics (slug, name) values (%s, %s)"
                " on conflict (slug) do nothing",
                (slug, slug),
            )
    conn.commit()
    seed_cf._cache = None  # the tag->topic map is cached per process
    return user_id


def teardown(conn, user_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from submissions where user_id = %s", (user_id,))
        cur.execute("delete from topic_mastery where user_id = %s", (user_id,))
        cur.execute("delete from sync_state where user_id = %s", (user_id,))
        cur.execute("delete from users where id = %s", (user_id,))
        cur.execute(
            "delete from problem_topics where problem_id in"
            " (select id from problem_catalog where contest_id = 1700)"
        )
        cur.execute("delete from problem_catalog where contest_id = 1700")
    conn.commit()


def counts(conn, user_id: int) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            "select count(*) as n from submissions where user_id = %s", (user_id,)
        )
        subs = cur.fetchone()["n"]
        cur.execute(
            "select last_synced_submission_id as c, status from sync_state"
            " where user_id = %s and source = 'cf_api'",
            (user_id,),
        )
        row = cur.fetchone() or {}
        cur.execute("select count(*) as n from problem_catalog where contest_id = 1700")
        probs = cur.fetchone()["n"]
        cur.execute(
            "select count(*) as n from problem_topics pt"
            " join problem_catalog p on p.id = pt.problem_id"
            " where p.contest_id = 1700 and pt.origin = 'cf_tag'"
        )
        links = cur.fetchone()["n"]
    return {
        "submissions": subs,
        "cursor": row.get("c"),
        "status": row.get("status"),
        "problems": probs,
        "links": links,
    }


# --- the tests --------------------------------------------------------------


def test_statements_per_page(conn, user_id: int) -> None:
    """Three statements per page, whatever the page size. This is the fix."""
    print("\nstatements per page")
    topic_ids = seed_cf.tag_topic_ids(conn)
    for size in (1, 10, 500):
        with conn.cursor() as inner:
            cur = CountingCursor(inner)
            sync.write_page(cur, user_id, account(size), topic_ids)
            check(f"{size:>3} submissions -> statements", cur.n, 3)
        conn.rollback()
    # The old loop was ~4 per submission; 500 rows would have been ~2,000
    # statements, which at 86ms per round trip is nearly three minutes.


async def test_first_sync(conn, user_id: int) -> dict:
    """A full first sync, paginated, from an empty cursor."""
    print("\nfirst sync (5 submissions, 2 per page)")
    fake = install(FakeCF(account(5)))
    result = await sync.sync_user(conn, user_id)
    c = counts(conn, user_id)
    check("new_submissions", result["new_submissions"], 5)
    check("submissions stored", c["submissions"], 5)
    check("problems stored", c["problems"], 2)
    check("cf_tag links", c["links"], 3)  # greedy+math on A, dp on B
    check("cursor at newest id", c["cursor"], 1005)
    check("status", c["status"], "ok")
    # 5 submissions at 2 per page: pages of 2, 2, 1 — the short page ends it.
    check("CF status calls", fake.status_calls, 3)
    return c


async def test_idempotent(conn, user_id: int, before: dict) -> None:
    """Re-running changes nothing. Every retry depends on this."""
    print("\nre-run is a no-op")
    install(FakeCF(account(5)))
    result = await sync.sync_user(conn, user_id)
    check("new_submissions", result["new_submissions"], 0)
    check("counts unchanged", counts(conn, user_id), before)


async def test_verdict_upsert(conn, user_id: int) -> None:
    """TESTING -> OK lands on the existing row, not a new one."""
    print("\nverdict update on re-sync")
    with conn.cursor() as cur:
        cur.execute(
            "update submissions set verdict = 'TESTING'"
            " where user_id = %s and external_submission_id = 1003",
            (user_id,),
        )
        cur.execute(
            "update sync_state set last_synced_submission_id = 0"
            " where user_id = %s and source = 'cf_api'",
            (user_id,),
        )
    conn.commit()

    # CF now reports OK for that submission — the exact TESTING -> OK case the
    # upsert's update branch exists for.
    install(FakeCF(account(5, verdicts={1003: "OK"})))
    await sync.sync_user(conn, user_id)

    with conn.cursor() as cur:
        cur.execute(
            "select verdict from submissions"
            " where user_id = %s and external_submission_id = 1003",
            (user_id,),
        )
        verdict = cur.fetchone()["verdict"]
    check("verdict corrected", verdict, "OK")
    check("no duplicate row", counts(conn, user_id)["submissions"], 5)


async def test_incremental(conn, user_id: int) -> None:
    """New submissions arrive; the walk stops at the first known id."""
    print("\nincremental sync")
    fake = install(FakeCF(account(7)))
    result = await sync.sync_user(conn, user_id)
    c = counts(conn, user_id)
    check("new_submissions", result["new_submissions"], 2)
    check("submissions stored", c["submissions"], 7)
    check("cursor advanced", c["cursor"], 1007)
    # Two new submissions at 2 per page: page one is all new, so it takes a
    # second page to meet a known id and learn the walk is done.
    check("stopped at the first known id", fake.status_calls, 2)


async def test_killed_walk_keeps_cursor(conn, user_id: int) -> None:
    """The newest-first trap: a walk killed mid-way must not move the cursor,
    and must keep the rows it already committed."""
    print("\nkilled mid-walk")
    with conn.cursor() as cur:
        cur.execute("delete from submissions where user_id = %s", (user_id,))
        cur.execute(
            "update sync_state set last_synced_submission_id = 0"
            " where user_id = %s and source = 'cf_api'",
            (user_id,),
        )
    conn.commit()

    install(FakeCF(account(5), fail_on_page=2))
    try:
        await sync.sync_user(conn, user_id)
        check("raised", "no exception", "RuntimeError")
    except RuntimeError:
        pass

    c = counts(conn, user_id)
    check("page 1 rows kept", c["submissions"], 2)
    check("cursor NOT advanced", c["cursor"], 0)
    check("status", c["status"], "error")

    # And the next run picks up the whole history rather than stopping at the
    # newest id — which is exactly what a mid-walk cursor would have caused.
    install(FakeCF(account(5)))
    await sync.sync_user(conn, user_id)
    c = counts(conn, user_id)
    check("recovered fully", c["submissions"], 5)
    check("cursor at newest id", c["cursor"], 1005)


async def test_cursor_survives_refit_failure(conn, user_id: int) -> None:
    """The cursor is written with the rows it covers, not after the mastery
    refit — so a run that dies in the refit keeps the work it committed."""
    print("\nkilled during the mastery refit")
    with conn.cursor() as cur:
        cur.execute("delete from submissions where user_id = %s", (user_id,))
        cur.execute(
            "update sync_state set last_synced_submission_id = 0"
            " where user_id = %s and source = 'cf_api'",
            (user_id,),
        )
    conn.commit()

    def boom(*a, **kw):
        raise RuntimeError("simulated kill during refit")

    real_recompute = sync.mastery.recompute_user
    sync.mastery.recompute_user = boom
    install(FakeCF(account(5)))
    try:
        await sync.sync_user(conn, user_id)
        check("raised", "no exception", "RuntimeError")
    except RuntimeError:
        pass
    finally:
        sync.mastery.recompute_user = real_recompute

    c = counts(conn, user_id)
    check("rows kept", c["submissions"], 5)
    check("cursor advanced anyway", c["cursor"], 1005)

    # So the retry is incremental rather than a full re-walk.
    fake = install(FakeCF(account(5)))
    result = await sync.sync_user(conn, user_id)
    check("retry re-reads nothing", result["new_submissions"], 0)
    check("retry reads one page", fake.status_calls, 1)


def test_seeder_helpers(conn, user_id: int) -> None:
    """seed_cf imports the single-problem forms; they must still work."""
    print("\nsingle-problem helpers (used by seed_cf)")
    topic_ids = seed_cf.tag_topic_ids(conn)
    with conn.cursor() as cur:
        pid = sync.upsert_problem(cur, PROBLEMS["A"])
        check_true("upsert_problem returns an id", isinstance(pid, int))
        sync.link_cf_tags(cur, pid, PROBLEMS["A"]["tags"], topic_ids)
        cur.execute(
            "select count(*) as n from problem_topics"
            " where problem_id = %s and origin = 'cf_tag'",
            (pid,),
        )
        check("links written", cur.fetchone()["n"], 2)
        # A problem with no contestId/index (the acmsguru archive) has no key.
        check("acmsguru problem skipped", sync.upsert_problem(cur, {"name": "x"}), None)
    conn.commit()


async def test_quick_leaves_cursor(conn, user_id: int) -> None:
    """quick=true reads only the newest page, so on a fresh account it must not
    claim the history behind it."""
    print("\nquick path on a fresh account")
    with conn.cursor() as cur:
        cur.execute("delete from submissions where user_id = %s", (user_id,))
        cur.execute(
            "update sync_state set last_synced_submission_id = 0"
            " where user_id = %s and source = 'cf_api'",
            (user_id,),
        )
    conn.commit()

    fake = install(FakeCF(account(120)))
    result = await sync.sync_user(conn, user_id, quick=True)
    c = counts(conn, user_id)
    check("read one page only", fake.status_calls, 1)
    check("stored the newest 50", c["submissions"], 50)
    check("cursor NOT advanced", c["cursor"], 0)
    check("new_submissions", result["new_submissions"], 50)

    # The full sync behind it still gets everything.
    install(FakeCF(account(120)))
    await sync.sync_user(conn, user_id)
    c = counts(conn, user_id)
    check("full sync backfills", c["submissions"], 120)
    check("cursor at newest id", c["cursor"], 1120)


# --- runner -----------------------------------------------------------------


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL is not set — point this at a scratch database")
        return 2

    # Small pages, so pagination is exercised without 2,000-row fixtures.
    sync.PAGE_SIZE = 2

    with db.connect() as conn:
        user_id = setup(conn)
        try:
            test_statements_per_page(conn, user_id)
            before = await test_first_sync(conn, user_id)
            await test_idempotent(conn, user_id, before)
            await test_verdict_upsert(conn, user_id)
            await test_incremental(conn, user_id)
            await test_killed_walk_keeps_cursor(conn, user_id)
            await test_cursor_survives_refit_failure(conn, user_id)
            test_seeder_helpers(conn, user_id)
            await test_quick_leaves_cursor(conn, user_id)
        finally:
            teardown(conn, user_id)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
