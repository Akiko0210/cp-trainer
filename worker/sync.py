"""Codeforces sync pipeline (handoff §5): passive full-history mirror.

Per run:
  1. Refresh the user's rating/rank from user.info.
  2. Pull new submissions since sync_state.last_synced_submission_id
     (full paginated history on first run); upsert problems + submissions.
  3. Reconcile: attach submissions to attempts by (problem, time window) and
     derive time_to_first_submit_s / debug_time_s from judge timestamps —
     the judge wins on facts it records.
  4. Recompute topic mastery for the user.
"""

import logging
from datetime import datetime, timezone

import psycopg

import cf_api
import mastery
from seed_cf import CF_TAG_TO_MODULE, tag_topic_ids

log = logging.getLogger("sync")

PAGE_SIZE = 2000

# Postgres binds at most 65535 parameters per statement. Every batch below is
# split to stay under it, so PAGE_SIZE can be raised later without anyone
# tripping over a limit they didn't know was there.
MAX_BIND_PARAMS = 60000


def _chunked(rows: list, params_per_row: int):
    """Split rows so one statement never exceeds the bind-parameter limit."""
    size = max(1, MAX_BIND_PARAMS // params_per_row)
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


def _external_id(prob: dict) -> str | None:
    """CF `problem` -> our catalog key, or None for problems that have none
    (the acmsguru archive carries no contestId/index)."""
    if "contestId" not in prob or "index" not in prob:
        return None
    return f"{prob['contestId']}{prob['index']}"


def upsert_problems(cur, probs: list[dict]) -> dict[str, int]:
    """Upsert CF `problem` objects in one statement per chunk.

    Returns {external_id: problem_id}. Against a hosted Postgres a round trip is
    ~86ms and 500 rows in one call cost the same as one row, so batching here is
    the difference between a 20-minute first sync and a few seconds.
    """
    rows: dict[str, tuple] = {}
    for prob in probs:
        external_id = _external_id(prob)
        if external_id is None:
            continue
        # Dedupe within the statement: `on conflict do update` raises "cannot
        # affect row a second time" if one VALUES list names the same conflict
        # target twice, and a page of submissions repeats problems constantly.
        rows[external_id] = (
            external_id,
            prob["contestId"],
            prob.get("name", external_id),
            f"https://codeforces.com/contest/{prob['contestId']}/problem/{prob['index']}",
            prob.get("rating"),
            prob.get("tags", []),
        )

    ids: dict[str, int] = {}
    for chunk in _chunked(list(rows.values()), 6):
        values = ",".join(["('cf',%s,%s,%s,%s,%s,%s)"] * len(chunk))
        cur.execute(
            f"""
            insert into problem_catalog
              (source, external_id, contest_id, title, url, rating, tags)
            values {values}
            on conflict (source, external_id) do update set
              contest_id = coalesce(problem_catalog.contest_id, excluded.contest_id),
              rating = coalesce(problem_catalog.rating, excluded.rating),
              tags = case when problem_catalog.tags = '{{}}' then excluded.tags
                          else problem_catalog.tags end
            returning id, external_id
            """,
            [v for row in chunk for v in row],
        )
        # The conflict branch always fires, so every input row comes back.
        ids.update({r["external_id"]: r["id"] for r in cur.fetchall()})
    return ids


def link_cf_tags_batch(cur, pairs: set[tuple[int, int]]) -> None:
    """Insert (problem_id, topic_id) cf_tag links, one statement per chunk.

    Sorted so that two syncs touching the same problems take the row locks in
    the same order.
    """
    for chunk in _chunked(sorted(pairs), 2):
        values = ",".join(["(%s,%s,'cf_tag')"] * len(chunk))
        cur.execute(
            f"""
            insert into problem_topics (problem_id, topic_id, origin)
            values {values} on conflict do nothing
            """,
            [v for pair in chunk for v in pair],
        )


def upsert_problem(cur, prob: dict) -> int | None:
    """Single-problem form of upsert_problems; used by the problemset seeder."""
    return next(iter(upsert_problems(cur, [prob]).values()), None)


def link_cf_tags(cur, problem_id: int, tags: list[str], topic_ids: dict) -> None:
    """cf_tag-origin supplement: map CF tags to module topics (volume signal)."""
    pairs = {(problem_id, topic_ids[t]) for t in tags if topic_ids.get(t)}
    if pairs:
        link_cf_tags_batch(cur, pairs)


def write_page(cur, user_id: int, subs: list[dict], topic_ids: dict) -> None:
    """Write one page of submissions in three batched phases.

    Three statements per page (plus chunking) instead of ~4 per submission,
    which is what the page loop used to cost. Nothing about *what* is written
    changes — in particular the submissions insert is still an upsert, because
    verdicts genuinely change (TESTING -> OK) and a re-run must correct them.
    """
    problem_ids = upsert_problems(cur, [s.get("problem", {}) for s in subs])

    links: set[tuple[int, int]] = set()
    rows: list[tuple] = []
    seen: set[int] = set()
    for s in subs:
        prob = s.get("problem", {})
        problem_id = problem_ids.get(_external_id(prob))
        if problem_id is not None:
            for tag in prob.get("tags", []):
                tid = topic_ids.get(tag)
                if tid:
                    links.add((problem_id, tid))
        sid = s["id"]
        if sid in seen:
            continue  # same one-conflict-target-per-statement rule as above
        seen.add(sid)
        rows.append(
            (
                user_id,
                problem_id,
                s.get("verdict"),
                s.get("programmingLanguage"),
                s["creationTimeSeconds"],
                s.get("timeConsumedMillis"),
                s.get("memoryConsumedBytes"),
                (s.get("author") or {}).get("participantType"),
                sid,
            )
        )

    link_cf_tags_batch(cur, links)

    for chunk in _chunked(rows, 9):
        values = ",".join(
            ["(%s,%s,%s,%s,to_timestamp(%s),%s,%s,%s,'cf_api',%s)"] * len(chunk)
        )
        cur.execute(
            f"""
            insert into submissions
              (user_id, problem_id, verdict, language, submitted_at,
               time_ms, memory_bytes, participant_type, source,
               external_submission_id)
            values {values}
            on conflict (user_id, source, external_submission_id)
              do update set verdict = excluded.verdict,
                            time_ms = excluded.time_ms,
                            memory_bytes = excluded.memory_bytes,
                            participant_type = excluded.participant_type
            """,
            [v for row in chunk for v in row],
        )


def _persist_cursor(cur, user_id: int, last_synced: int) -> None:
    """Advance the resume point, in the same transaction as the rows it covers.

    Only ever called once a walk is complete, and that restriction is the whole
    subtlety. Codeforces returns submissions newest-first, so after page one
    `max_seen` is already the newest id in the account — persisting it mid-walk
    would make the next run stop at page one and never fetch the *older* pages,
    silently losing history. A walk is complete when it meets a submission we
    already hold, or runs off the end of the account.

    It lives here rather than after reconcile + the mastery refit (where it used
    to be) so that a run killed during the refit still records the submissions
    it had already committed.
    """
    cur.execute(
        """
        update sync_state set last_synced_submission_id = %s
        where user_id = %s and source = 'cf_api'
        """,
        (last_synced, user_id),
    )


async def sync_user(conn: psycopg.Connection, user_id: int, quick: bool = False) -> dict:
    """Mirror one user's CF history. quick=True fetches only the newest page
    (used by the solve view to catch a verdict right after submitting)."""
    with conn.cursor() as cur:
        cur.execute("select * from users where id = %s", (user_id,))
        user = cur.fetchone()
        if not user or not user["cf_handle"]:
            raise ValueError(f"user {user_id} has no cf_handle")
        handle = user["cf_handle"]

        cur.execute(
            """
            insert into sync_state (user_id, source, status, last_run_at)
            values (%s, 'cf_api', 'running', now())
            on conflict (user_id, source)
              do update set status = 'running', message = null, last_run_at = now()
            returning last_synced_submission_id
            """,
            (user_id,),
        )
        last_synced = cur.fetchone()["last_synced_submission_id"] or 0
    conn.commit()

    try:
        result = await _run(conn, user_id, handle, last_synced, quick)
        # last_synced_submission_id is not written here: _run persists it with
        # the rows it covers, so that work already committed survives a run that
        # dies later on (see _persist_cursor).
        with conn.cursor() as cur:
            cur.execute(
                """
                update sync_state set status = 'ok', message = null, last_run_at = now()
                where user_id = %s and source = 'cf_api'
                """,
                (user_id,),
            )
        conn.commit()
        return result
    except Exception as e:
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute(
                """
                update sync_state set status = 'error', message = %s, last_run_at = now()
                where user_id = %s and source = 'cf_api'
                """,
                (str(e)[:500], user_id),
            )
        conn.commit()
        raise


async def _run(conn, user_id: int, handle: str, last_synced: int, quick: bool) -> dict:
    if not quick:
        info = (await cf_api.call("user.info", handles=handle))[0]
        with conn.cursor() as cur:
            cur.execute(
                """
                update users set cf_rating = %s, cf_max_rating = %s, cf_rank = %s
                where id = %s
                """,
                (info.get("rating"), info.get("maxRating"), info.get("rank"), user_id),
            )
        conn.commit()

    topic_ids = tag_topic_ids(conn)

    new_count = 0
    max_seen = last_synced
    complete = False
    start = 1
    count = 50 if quick else PAGE_SIZE
    while True:
        subs = await cf_api.call(
            "user.status", handle=handle, **{"from": start, "count": count}
        )

        fresh: list[dict] = []
        reached_known = False
        for s in subs:
            if s["id"] <= last_synced:
                reached_known = True
                break
            fresh.append(s)

        # Met data we already hold, or ran off the end of the account: from here
        # down, everything is mirrored. Until one of those is true we hold only
        # a suffix from the newest submission, and the cursor must not move.
        complete = reached_known or len(subs) < count

        with conn.cursor() as cur:
            if fresh:
                write_page(cur, user_id, fresh, topic_ids)
                new_count += len(fresh)
                max_seen = max(max_seen, max(s["id"] for s in fresh))
            if complete and max_seen > last_synced:
                _persist_cursor(cur, user_id, max_seen)
        conn.commit()

        if complete or quick:
            # quick=true deliberately reads only the newest page, so it leaves
            # the walk incomplete and the cursor untouched unless it happened to
            # reach known data. The next full sync re-walks from the top.
            break
        start += count

    reconcile_attempts(conn, user_id)
    topics_written = mastery.recompute_user(conn, user_id)
    log.info(
        "sync user=%s new_submissions=%s topics=%s", user_id, new_count, topics_written
    )
    return {
        "new_submissions": new_count,
        "topics_recomputed": topics_written,
        # What the cursor actually reads now, not the newest id seen — an
        # incomplete walk leaves it where it was.
        "last_synced": max_seen if complete else last_synced,
    }


def reconcile_attempts(conn, user_id: int) -> None:
    """Reconciliation rule (§3): an attempt owns the submissions on its problem
    inside [started_at, ended_at]. Derive first-submit and debug time from judge
    timestamps; the user only ever supplied started_at and mistake tags."""
    with conn.cursor() as cur:
        cur.execute(
            """
            update attempts a set
              time_to_first_submit_s = extract(epoch from w.first_sub - a.started_at)::int,
              debug_time_s = case
                when w.first_ok is not null
                  then extract(epoch from w.first_ok - w.first_sub)::int
                when a.ended_at is not null
                  then extract(epoch from a.ended_at - w.first_sub)::int
                else null end
            from (
              select a2.id,
                min(s.submitted_at) as first_sub,
                min(s.submitted_at) filter (where s.verdict = 'OK') as first_ok
              from attempts a2
              join submissions s on s.user_id = a2.user_id
                and s.problem_id = a2.problem_id
                and s.submitted_at >= a2.started_at
                and s.submitted_at <= coalesce(a2.ended_at, now())
              where a2.user_id = %s
              group by a2.id
            ) w
            where a.id = w.id
            """,
            (user_id,),
        )
    conn.commit()
