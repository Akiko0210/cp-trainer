"""Topic mastery: a two-level ability fit, plus the heat score.

Two numbers per (user, topic), kept distinct because they answer different
questions:

  rating_estimate  "what difficulty can you handle here" — fitted under the
                   Rasch/Elo model (estimator.py) over the problems you have
                   engaged with in the topic, successes AND failures.

  score (0-100)    "are you on fire here right now" — current heat. Three
                   factors multiply: level (topic ability vs your own overall
                   ability), evidence (recency-weighted observation mass), and
                   freshness (1.0 for a month after your last activity, then a
                   90-day half-life). A topic you were once strong at but have
                   not touched in 200 days reads single digits; 100 is reserved
                   for topics you are actively pushing above your own level.

WHY TWO LEVELS
--------------
The two corrections in estimator.py's docstring pull in opposite directions,
and only one of them can be applied per-topic:

  Level 1 — the calibrated anchor. Fit over every problem in every contest the
    user entered, solved or not. Counting the problems they never opened is
    what removes the selection bias, and it is validated: for this account it
    recovers ~1700 against a true CF rating of 1595 (the residual is expected,
    since CF rating additionally prices rank and speed, and lags improvement).
    Stored on users.ability_estimate.

  Level 2 — per-topic deviation. A contest problem the user never opened says
    nothing about a TOPIC: they never read it, so its being a flow problem is
    no evidence about flows. Including those per-topic drags every topic to the
    global mean (measured: all eight categories within +/-40 of each other,
    which is useless for a mastery map). So topic fits use only problems the
    user actually engaged with, with the prior centred on the global
    engaged-universe fit — standard partial pooling, so sparse topics stay near
    your overall level instead of swinging on three observations.

Because level 2 runs over a different universe (engaged problems solve at ~90%,
full contest sets at ~55%), its fits sit systematically high. We measure that
gap once — `selection_offset` = engaged-universe global minus calibrated anchor
— and subtract it from every topic estimate, which puts topic numbers back on
the same scale as the anchor and makes the average topic land at your overall
ability instead of 200 points above it.

Every score keeps its `contributors`: one row per observation with the
effective difficulty, the model's predicted solve probability, and the `push`
that observation applied. The pushes balance against the prior's pull, so the
estimate is auditable arithmetic rather than a black box.
"""

import json
from datetime import datetime, timezone

import psycopg

import estimator
from estimator import Obs

# --- heat score tunables (the estimator owns the fit's own constants) ------

STALE_AFTER_DAYS = 45
RECENT_WINDOW_DAYS = 90
GAP_SCALE = 3.0  # Elo per level point; +/-150 vs your own level spans 0..100
EVIDENCE_FULL_AT = 6.0  # recency-weighted observation mass for evidence = 1.0
EVIDENCE_FLOOR = 0.3
FRESH_GRACE_DAYS = 30.0
DECAY_HALF_LIFE = 90.0
HEAT_HALF_LIFE_DAYS = 90.0
TREND_DEADBAND = 15.0
TREND_WINDOW_DAYS = 30.0
MAX_CONTRIBUTORS = 60

NON_ATTEMPT_VERDICTS = ("COMPILATION_ERROR", "SKIPPED", "TESTING")


def _engagement_obs(r: dict, now: datetime, fast: bool) -> Obs:
    """One problem the user has submitted to -> one observation.

    Regime decides how the outcome is read (see estimator.py):
      contest solve    full weight, nominal difficulty  (the calibrated case)
      practice solve   down-weighted, discounted difficulty
      any failure      full weight, nominal difficulty; a lone failed
                       submission is down-weighted as a possible non-attempt
    """
    solved = bool(r["solved"])
    in_contest = bool(r["contest_solved"]) if solved else bool(r["contest_tried"])
    stamp = r["ac_at"] if solved else r["last_sub_at"]
    age_days = max(0.0, (now - stamp).total_seconds() / 86400)
    weight = estimator.recency_weight(age_days)
    difficulty = float(r["rating"])

    if solved:
        adj = estimator.CLEAN_BONUS.get(r["wa_count"] or 0, estimator.GRINDY_PENALTY)
        if fast:
            adj += estimator.FAST_DEBUG_BONUS
        difficulty += adj
        if not in_contest:
            difficulty -= estimator.PRACTICE_DISCOUNT
            weight *= estimator.PRACTICE_SOLVE_WEIGHT
    elif (r["failed_subs"] or 0) < 2:
        weight *= estimator.LONE_FAILURE_WEIGHT

    return Obs(r["problem_id"], difficulty, solved, weight)


def _fit_anchor(cur, user_id: int, now: datetime, fallback: float) -> estimator.Fit:
    """Level 1: ability over the FULL problem set of every contest entered.

    Counting problems the user never submitted to is the selection-bias
    correction — it is what CF's own rating calibration does implicitly.
    """
    cur.execute(
        f"""
        with entered as (
          select distinct p.contest_id
          from submissions s
          join problem_catalog p on p.id = s.problem_id
          where s.user_id = %(uid)s and p.contest_id is not null
            and s.participant_type in {estimator.CONTEST_REGIMES}
        ),
        -- when the user was in that contest, for recency weighting
        contest_when as (
          select p.contest_id, max(s.submitted_at) as at
          from submissions s
          join problem_catalog p on p.id = s.problem_id
          where s.user_id = %(uid)s and p.contest_id is not null
            and s.participant_type in {estimator.CONTEST_REGIMES}
          group by p.contest_id
        )
        select p.id as problem_id, p.rating, w.at,
               exists (
                 select 1 from submissions s2
                 where s2.user_id = %(uid)s and s2.problem_id = p.id
                   and s2.verdict = 'OK'
                   and s2.participant_type in {estimator.CONTEST_REGIMES}
               ) as solved
        from problem_catalog p
        join entered e on e.contest_id = p.contest_id
        join contest_when w on w.contest_id = p.contest_id
        where p.rating is not null
        """,
        {"uid": user_id},
    )
    obs = []
    for r in cur.fetchall():
        age = max(0.0, (now - r["at"]).total_seconds() / 86400)
        w = estimator.recency_weight(age)
        if not r["solved"]:
            w *= estimator.UNATTEMPTED_WEIGHT
        obs.append(Obs(r["problem_id"], float(r["rating"]), r["solved"], w))
    if not obs:
        # No contest history: nothing to calibrate against, so trust CF rating.
        return estimator.Fit(fallback, estimator.prior_sigma(), 0.0, fallback, {})
    # Wide prior: let the contest record speak for itself.
    return estimator.fit(obs, fallback, sigma=1500.0)


def recompute_user(conn: psycopg.Connection, user_id: int) -> int:
    """Recompute the user's ability anchor and all topic_mastery rows."""
    now = datetime.now(timezone.utc)

    with conn.cursor() as cur:
        cur.execute("select cf_rating from users where id = %s", (user_id,))
        row = cur.fetchone()
        cf_rating = float((row and row["cf_rating"]) or estimator.UNRATED_BASELINE)

        anchor = _fit_anchor(cur, user_id, now, cf_rating)

        # Every problem the user has engaged with, solved or not, tagged with
        # whether the engagement happened under contest conditions.
        cur.execute(
            f"""
            with agg as (
              select s.problem_id,
                bool_or(s.verdict = 'OK') as solved,
                bool_or(s.verdict = 'OK'
                        and s.participant_type in {estimator.CONTEST_REGIMES}
                       ) as contest_solved,
                bool_or(s.participant_type in {estimator.CONTEST_REGIMES}
                       ) as contest_tried,
                min(s.submitted_at) filter (where s.verdict = 'OK') as ac_at,
                max(s.submitted_at) as last_sub_at,
                count(*) filter (
                  where s.verdict is distinct from 'OK'
                    and s.verdict not in {NON_ATTEMPT_VERDICTS}
                ) as failed_subs
              from submissions s
              where s.user_id = %(uid)s and s.problem_id is not null
              group by s.problem_id
            )
            select a.*, p.rating, p.external_id, p.title, p.url,
                   (select count(*) from submissions s2
                     where s2.user_id = %(uid)s and s2.problem_id = a.problem_id
                       and s2.submitted_at < a.ac_at and s2.verdict <> 'OK') as wa_count
            from agg a
            join problem_catalog p on p.id = a.problem_id
            where p.rating is not null and (a.solved or a.failed_subs >= 1)
            """,
            {"uid": user_id},
        )
        records = {r["problem_id"]: r for r in cur.fetchall()}

        # Timed attempts: problems where debug time beat the user's own median.
        cur.execute(
            """select problem_id, min(debug_time_s) as debug_s from attempts
               where user_id = %s and debug_time_s is not null group by problem_id""",
            (user_id,),
        )
        debug_times = {r["problem_id"]: r["debug_s"] for r in cur.fetchall()}
        median_debug = None
        if debug_times:
            vals = sorted(debug_times.values())
            median_debug = vals[len(vals) // 2]

        obs_by_problem: dict[int, Obs] = {}
        for pid, r in records.items():
            fast = (
                median_debug is not None
                and pid in debug_times
                and debug_times[pid] < median_debug
            )
            obs_by_problem[pid] = _engagement_obs(r, now, fast)

        # The engaged universe's own global fit, and the gap to the calibrated
        # anchor. Subtracting that gap puts topic estimates on the anchor's
        # scale, so the average topic reads "your level" rather than +200.
        engaged_global = (
            estimator.fit(list(obs_by_problem.values()), cf_rating, sigma=1500.0)
            if obs_by_problem
            else estimator.Fit(cf_rating, 0.0, 0.0, cf_rating, {})
        )
        selection_offset = (
            engaged_global.theta - anchor.theta if obs_by_problem else 0.0
        )

        cur.execute(
            """update users set ability_estimate = %s, ability_se = %s,
                                selection_offset = %s where id = %s""",
            (round(anchor.theta, 1), round(anchor.se, 1),
             round(selection_offset, 1), user_id),
        )

        if not records:
            conn.commit()
            return 0

        # Problems -> module topics (curated + cf_tag origins).
        cur.execute(
            """select distinct pt.topic_id, pt.problem_id from problem_topics pt
               where pt.problem_id = any(%s)""",
            (list(records.keys()),),
        )
        topic_problems: dict[int, set[int]] = {}
        for r in cur.fetchall():
            topic_problems.setdefault(r["topic_id"], set()).add(r["problem_id"])

        # Chapters aggregate their children; categories aggregate every module
        # carrying their category_slug.
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
            observations = [obs_by_problem[pid] for pid in problem_ids]
            # Partial pooling: prior centred on the engaged-universe global, so
            # a topic with little evidence reads "about your usual level".
            f = estimator.fit(observations, engaged_global.theta)
            estimate = f.theta - selection_offset

            # Trend: refit over only the observations that existed a window
            # ago. Same formula, earlier data — stable across recomputes.
            past_obs = []
            for pid in problem_ids:
                r = records[pid]
                stamp = r["ac_at"] if r["solved"] else r["last_sub_at"]
                past_age = (now - stamp).total_seconds() / 86400 - TREND_WINDOW_DAYS
                if past_age >= 0:
                    o = obs_by_problem[pid]
                    ratio = estimator.recency_weight(past_age) / max(
                        1e-9, estimator.recency_weight(past_age + TREND_WINDOW_DAYS)
                    )
                    past_obs.append(Obs(pid, o.difficulty, o.solved, o.weight * ratio))
            trend = 0
            if past_obs:
                past_theta = estimator.fit(past_obs, engaged_global.theta).theta
                if abs(f.theta - past_theta) > TREND_DEADBAND:
                    trend = 1 if f.theta > past_theta else -1

            solved_count = recent_solves = 0
            last_solve_at = last_activity_at = None
            heat_mass = 0.0
            contributors = []
            for pid in problem_ids:
                r = records[pid]
                o = obs_by_problem[pid]
                stamp = r["ac_at"] if r["solved"] else r["last_sub_at"]
                age_days = max(0.0, (now - stamp).total_seconds() / 86400)
                if r["solved"]:
                    solved_count += 1
                    if age_days <= RECENT_WINDOW_DAYS:
                        recent_solves += 1
                    if last_solve_at is None or r["ac_at"] > last_solve_at:
                        last_solve_at = r["ac_at"]
                if last_activity_at is None or r["last_sub_at"] > last_activity_at:
                    last_activity_at = r["last_sub_at"]
                heat_mass += o.weight * 0.5 ** (age_days / HEAT_HALF_LIFE_DAYS)

                p = estimator.p_solve(f.theta, o.difficulty)
                contributors.append(
                    {
                        "problem_id": pid,
                        "external_id": r["external_id"],
                        "title": r["title"],
                        "url": r["url"],
                        "rating": r["rating"],
                        "effective_difficulty": round(o.difficulty),
                        "solved": r["solved"],
                        "in_contest": bool(
                            r["contest_solved"] if r["solved"] else r["contest_tried"]
                        ),
                        "wa_count": r["wa_count"] or 0,
                        "at": stamp.isoformat(),
                        "weight": round(o.weight, 4),
                        "p_solve": round(p, 4),
                        "push": round(
                            o.weight * ((1.0 if r["solved"] else 0.0) - p), 4
                        ),
                    }
                )

            level = max(
                0.0,
                min(100.0, 50 + (f.theta - engaged_global.theta) / GAP_SCALE),
            )
            evidence = EVIDENCE_FLOOR + (1 - EVIDENCE_FLOOR) * min(
                1.0, heat_mass / EVIDENCE_FULL_AT
            )
            idle = (
                (now - last_activity_at).total_seconds() / 86400
                if last_activity_at
                else 1e9
            )
            freshness = (
                1.0
                if idle <= FRESH_GRACE_DAYS
                else 0.5 ** ((idle - FRESH_GRACE_DAYS) / DECAY_HALF_LIFE)
            )
            score = level * evidence * freshness
            contributors.sort(key=lambda c: -abs(c["push"]))

            # Store the factors ACTUALLY used, so the UI displays the real
            # arithmetic instead of re-deriving it and drifting out of sync.
            factors = {
                "level": round(level, 2),
                "evidence": round(evidence, 3),
                "freshness": round(freshness, 3),
                "heat_mass": round(heat_mass, 3),
                "idle_days": round(idle, 1) if idle < 1e8 else None,
                "theta_engaged": round(f.theta, 1),
                "your_level": round(engaged_global.theta, 1),
                "selection_offset": round(selection_offset, 1),
                "n_obs": len(observations),
                "n_solved": solved_count,
                "prior_pull": round(
                    (f.theta - engaged_global.theta) / (estimator.prior_sigma() ** 2), 6
                ),
                "push_total": round(sum(c["push"] for c in contributors), 4),
            }

            cur.execute(
                """
                insert into topic_mastery
                  (user_id, topic_id, score, rating_estimate, estimate_se, n_eff,
                   confidence, trend, stale, solved_count, recent_solve_count,
                   last_practiced_at, last_activity_at, contributors, factors,
                   computed_at)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
                on conflict (user_id, topic_id) do update set
                  score = excluded.score,
                  factors = excluded.factors,
                  rating_estimate = excluded.rating_estimate,
                  estimate_se = excluded.estimate_se,
                  n_eff = excluded.n_eff,
                  confidence = excluded.confidence,
                  trend = excluded.trend,
                  stale = excluded.stale,
                  solved_count = excluded.solved_count,
                  recent_solve_count = excluded.recent_solve_count,
                  last_practiced_at = excluded.last_practiced_at,
                  last_activity_at = excluded.last_activity_at,
                  contributors = excluded.contributors,
                  computed_at = now()
                """,
                (
                    user_id,
                    topic_id,
                    round(score, 1),
                    round(estimate, 1),
                    round(f.se, 1),
                    round(f.n_eff, 3),
                    round(estimator.confidence_from_se(f.se), 3),
                    trend,
                    idle > STALE_AFTER_DAYS,
                    solved_count,
                    recent_solves,
                    last_solve_at,
                    last_activity_at,
                    json.dumps(contributors[:MAX_CONTRIBUTORS]),
                    json.dumps(factors),
                ),
            )
            written += 1

    conn.commit()
    return written
