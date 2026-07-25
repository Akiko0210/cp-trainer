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


def upsert_problem(cur, prob: dict) -> int | None:
    """Upsert a problem from a CF API `problem` object; returns catalog id."""
    if "contestId" not in prob or "index" not in prob:
        return None  # e.g. acmsguru problems; skip
    external_id = f"{prob['contestId']}{prob['index']}"
    cur.execute(
        """
        insert into problem_catalog (source, external_id, title, url, rating, tags)
        values ('cf', %s, %s, %s, %s, %s)
        on conflict (source, external_id) do update set
          rating = coalesce(problem_catalog.rating, excluded.rating),
          tags = case when problem_catalog.tags = '{}' then excluded.tags
                      else problem_catalog.tags end
        returning id
        """,
        (
            external_id,
            prob.get("name", external_id),
            f"https://codeforces.com/contest/{prob['contestId']}/problem/{prob['index']}",
            prob.get("rating"),
            prob.get("tags", []),
        ),
    )
    return cur.fetchone()["id"]


def link_cf_tags(cur, problem_id: int, tags: list[str], topic_ids: dict) -> None:
    """cf_tag-origin supplement: map CF tags to module topics (volume signal)."""
    for tag in tags:
        tid = topic_ids.get(tag)
        if tid:
            cur.execute(
                """
                insert into problem_topics (problem_id, topic_id, origin)
                values (%s, %s, 'cf_tag') on conflict do nothing
                """,
                (problem_id, tid),
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
        with conn.cursor() as cur:
            cur.execute(
                """
                update sync_state set status = 'ok', message = null, last_run_at = now(),
                  last_synced_submission_id = %s
                where user_id = %s and source = 'cf_api'
                """,
                (result["last_synced"], user_id),
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
    start = 1
    while True:
        count = 50 if quick else PAGE_SIZE
        subs = await cf_api.call(
            "user.status", handle=handle, **{"from": start, "count": count}
        )
        if not subs:
            break
        with conn.cursor() as cur:
            done = False
            for s in subs:
                sid = s["id"]
                if sid <= last_synced:
                    done = True
                    break
                max_seen = max(max_seen, sid)
                problem_id = upsert_problem(cur, s.get("problem", {}))
                if problem_id is not None:
                    link_cf_tags(
                        cur, problem_id, s.get("problem", {}).get("tags", []), topic_ids
                    )
                cur.execute(
                    """
                    insert into submissions
                      (user_id, problem_id, verdict, language, submitted_at,
                       time_ms, memory_bytes, source, external_submission_id)
                    values (%s,%s,%s,%s,to_timestamp(%s),%s,%s,'cf_api',%s)
                    on conflict (user_id, source, external_submission_id)
                      do update set verdict = excluded.verdict,
                                    time_ms = excluded.time_ms,
                                    memory_bytes = excluded.memory_bytes
                    """,
                    (
                        user_id,
                        problem_id,
                        s.get("verdict"),
                        s.get("programmingLanguage"),
                        s["creationTimeSeconds"],
                        s.get("timeConsumedMillis"),
                        s.get("memoryConsumedBytes"),
                        sid,
                    ),
                )
                new_count += 1
        conn.commit()
        if quick or done or len(subs) < count:
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
        "last_synced": max_seen,
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
