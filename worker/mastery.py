"""Topic mastery heuristic (handoff §6.1).

THE one module that owns the mastery formula. Deliberately transparent — every
score is backed by a `contributors` list of the actual solved problems and the
weight each carried, so the UI can show *why* a topic reads weak or strong.
Tune the constants below; nothing elsewhere knows the formula.

Per (user, topic), over the user's solved CF problems in that topic:

  recency weight   w = 0.5 ** (age_days / HALF_LIFE_DAYS)      # 90-day half-life
  clean adjust     rating bumped up for clean solves (<=1 wrong submission,
                   and debug time below the user's median when timed),
                   down for grindy ones (3+ wrong submissions)
  rating_estimate  = recency-weighted mean of adjusted ratings
                     ("how hard is the stuff you solve here")
  confidence       = min(1, solves in last 90d / 8)

  score (0-100) is CURRENT HEAT, not lifetime achievement — 100 means "on fire
  right now". Three factors multiply:
    level     = 50 + (rating_estimate - user_cf_rating) / GAP_SCALE, clamped
    evidence  = EVIDENCE_FLOOR + (1 - EVIDENCE_FLOOR) * confidence
                (no recent volume -> at most 30% of level survives)
    freshness = 1.0 while last solve <= FRESH_GRACE_DAYS old, then decays
                with a DECAY_HALF_LIFE half-life (a topic untouched for 200+
                days reads single-digits no matter how strong it once was)
    score     = level * evidence * freshness

  trend            = sign of rating_estimate change vs the estimate the same
                     formula produced TREND_WINDOW_DAYS ago (computed in the same
                     pass from solves that existed then — stable across recomputes)
  stale            = no solve in the topic for STALE_AFTER_DAYS  -> "time to review"

Module topics score their own problems; chapter topics aggregate their
children; category topics (slug 'cat-*') aggregate every module carrying
their category_slug — one comprehensive score per major ICPC area.
"""

import json
from datetime import datetime, timezone

import psycopg

HALF_LIFE_DAYS = 90.0
STALE_AFTER_DAYS = 45
RECENT_WINDOW_DAYS = 90
CONFIDENCE_FULL_AT = 8  # recent solves for confidence = 1.0
GAP_SCALE = 6.0  # rating points per score point; +/-300 rating gap spans 0..100
EVIDENCE_FLOOR = 0.3  # score multiplier at zero recent volume
FRESH_GRACE_DAYS = 30.0  # no decay within a month of the last solve
DECAY_HALF_LIFE = 90.0  # after the grace month, freshness halves every 90 days
TREND_DEADBAND = 15.0  # rating_estimate must move this much to count as a trend
TREND_WINDOW_DAYS = 30.0  # trend compares now vs the estimate as of this long ago
UNRATED_BASELINE = 1200  # score anchor for users with no CF rating yet
MAX_CONTRIBUTORS = 60

# Adjustment to a solve's effective rating based on how messy it was.
CLEAN_BONUS = {0: 60, 1: 30, 2: 0}  # wrong submissions before AC -> bonus
GRINDY_PENALTY = -60  # 3+ wrong submissions
FAST_DEBUG_BONUS = 30  # timed solve with debug time below user median


def recompute_user(conn: psycopg.Connection, user_id: int) -> int:
    """Recompute all topic_mastery rows for a user. Returns rows written."""
    now = datetime.now(timezone.utc)

    with conn.cursor() as cur:
        cur.execute("select cf_rating from users where id = %s", (user_id,))
        row = cur.fetchone()
        base_rating = (row and row["cf_rating"]) or UNRATED_BASELINE

        # One solve record per solved problem: first AC, wrong submissions
        # before that AC, and the problem's difficulty rating.
        cur.execute(
            """
            with first_ac as (
              select problem_id, min(submitted_at) as ac_at
              from submissions
              where user_id = %s and verdict = 'OK' and problem_id is not null
              group by problem_id
            )
            select f.problem_id, f.ac_at, p.rating, p.external_id, p.title, p.url,
              (select count(*) from submissions s
                where s.user_id = %s and s.problem_id = f.problem_id
                  and s.submitted_at < f.ac_at and s.verdict <> 'OK') as wa_count
            from first_ac f
            join problem_catalog p on p.id = f.problem_id
            where p.rating is not null
            """,
            (user_id, user_id),
        )
        solves = {r["problem_id"]: r for r in cur.fetchall()}

        if not solves:
            return 0

        # Timed attempts: problems where debug time beat the user's own median.
        cur.execute(
            """
            select problem_id, min(debug_time_s) as debug_s
            from attempts
            where user_id = %s and debug_time_s is not null
            group by problem_id
            """,
            (user_id,),
        )
        debug_times = {r["problem_id"]: r["debug_s"] for r in cur.fetchall()}
        median_debug = None
        if debug_times:
            vals = sorted(debug_times.values())
            median_debug = vals[len(vals) // 2]

        # Solved problems -> module topics (both curated and cf_tag origins).
        cur.execute(
            """
            select distinct pt.topic_id, pt.problem_id
            from problem_topics pt
            where pt.problem_id = any(%s)
            """,
            (list(solves.keys()),),
        )
        topic_problems: dict[int, set[int]] = {}
        for r in cur.fetchall():
            topic_problems.setdefault(r["topic_id"], set()).add(r["problem_id"])

        # Chapter topics aggregate their children's problem sets; category
        # topics aggregate every module stamped with their category_slug.
        cur.execute(
            """select t.id, t.parent_id, c.id as category_id
               from topics t
               left join topics c on c.slug = t.category_slug
               where t.parent_id is not null"""
        )
        for r in cur.fetchall():
            child_set = topic_problems.get(r["id"])
            if not child_set:
                continue
            topic_problems.setdefault(r["parent_id"], set()).update(child_set)
            if r["category_id"] is not None:
                topic_problems.setdefault(r["category_id"], set()).update(child_set)

        written = 0
        for topic_id, problem_ids in topic_problems.items():
            contributors = []
            w_sum = 0.0
            wr_sum = 0.0
            # Same accumulators evaluated as of TREND_WINDOW_DAYS ago, over the
            # solves that existed then — gives a stable "was I rising?" signal.
            w_sum_past = 0.0
            wr_sum_past = 0.0
            recent = 0
            last_at = None
            for pid in problem_ids:
                s = solves[pid]
                age_days = max(0.0, (now - s["ac_at"]).total_seconds() / 86400)
                w = 0.5 ** (age_days / HALF_LIFE_DAYS)
                adj = CLEAN_BONUS.get(s["wa_count"], GRINDY_PENALTY)
                if (
                    median_debug is not None
                    and pid in debug_times
                    and debug_times[pid] < median_debug
                ):
                    adj += FAST_DEBUG_BONUS
                eff = s["rating"] + adj
                w_sum += w
                wr_sum += w * eff
                past_age = age_days - TREND_WINDOW_DAYS
                if past_age >= 0:  # solve already existed a window ago
                    w_past = 0.5 ** (past_age / HALF_LIFE_DAYS)
                    w_sum_past += w_past
                    wr_sum_past += w_past * eff
                if age_days <= RECENT_WINDOW_DAYS:
                    recent += 1
                if last_at is None or s["ac_at"] > last_at:
                    last_at = s["ac_at"]
                contributors.append(
                    {
                        "problem_id": pid,
                        "external_id": s["external_id"],
                        "title": s["title"],
                        "url": s["url"],
                        "rating": s["rating"],
                        "wa_count": s["wa_count"],
                        "solved_at": s["ac_at"].isoformat(),
                        "weight": round(w, 4),
                        "adjusted_rating": eff,
                    }
                )

            estimate = wr_sum / w_sum
            confidence = min(1.0, recent / CONFIDENCE_FULL_AT)
            level = max(0.0, min(100.0, 50 + (estimate - base_rating) / GAP_SCALE))
            evidence = EVIDENCE_FLOOR + (1 - EVIDENCE_FLOOR) * confidence
            idle_days = (now - last_at).total_seconds() / 86400 if last_at else 1e9
            freshness = (
                1.0
                if idle_days <= FRESH_GRACE_DAYS
                else 0.5 ** ((idle_days - FRESH_GRACE_DAYS) / DECAY_HALF_LIFE)
            )
            score = level * evidence * freshness
            trend = 0
            if w_sum_past > 0:
                past_estimate = wr_sum_past / w_sum_past
                if abs(estimate - past_estimate) > TREND_DEADBAND:
                    trend = 1 if estimate > past_estimate else -1
            stale = (
                last_at is None
                or (now - last_at).total_seconds() / 86400 > STALE_AFTER_DAYS
            )
            contributors.sort(key=lambda c: -c["weight"])

            cur.execute(
                """
                insert into topic_mastery
                  (user_id, topic_id, score, rating_estimate, confidence, trend,
                   stale, solved_count, recent_solve_count, last_practiced_at,
                   contributors, computed_at)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
                on conflict (user_id, topic_id) do update set
                  score = excluded.score,
                  rating_estimate = excluded.rating_estimate,
                  confidence = excluded.confidence,
                  trend = excluded.trend,
                  stale = excluded.stale,
                  solved_count = excluded.solved_count,
                  recent_solve_count = excluded.recent_solve_count,
                  last_practiced_at = excluded.last_practiced_at,
                  contributors = excluded.contributors,
                  computed_at = now()
                """,
                (
                    user_id,
                    topic_id,
                    round(score, 1),
                    round(estimate, 1),
                    round(confidence, 3),
                    trend,
                    stale,
                    len(problem_ids),
                    recent,
                    last_at,
                    json.dumps(contributors[:MAX_CONTRIBUTORS]),
                ),
            )
            written += 1

    conn.commit()
    return written
