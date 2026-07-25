import { one, q } from "./db";

// ---------- user ----------

export type User = {
  id: number;
  cf_handle: string;
  display_name: string | null;
  cf_rating: number | null;
  cf_max_rating: number | null;
  cf_rank: string | null;
  // Fitted from in-contest performance; see worker/estimator.py. The offset is
  // how much the problems you choose to engage with inflate an estimate.
  ability_estimate: number | null;
  ability_se: number | null;
  selection_offset: number | null;
};

// v1 UX assumes one user (schema is multi-tenant; every query below scopes by user_id).
export async function getCurrentUser(): Promise<User | null> {
  return one<User>("select * from users order by id limit 1");
}

// ---------- categories (the dashboard hero) ----------

export type MapTopic = {
  id: number;
  slug: string;
  name: string;
  chapter: string;
  score: number | null;
  rating_estimate: number | null;
  confidence: number | null;
  trend: number | null;
  stale: boolean | null;
  solved_count: number | null;
  last_practiced_at: string | null;
};

export type CategoryMastery = {
  id: number;
  slug: string; // 'cat-strings'
  name: string;
  score: number | null;
  rating_estimate: number | null;
  estimate_se: number | null;
  confidence: number | null;
  trend: number | null;
  solved_count: number | null;
  recent_solve_count: number | null;
  last_practiced_at: string | null;
  last_activity_at: string | null;
  module_count: number;
  stale_modules: number;
};

export async function getCategories(userId: number): Promise<CategoryMastery[]> {
  return q<CategoryMastery>(
    `select c.id, c.slug, c.name,
            m.score, m.rating_estimate, m.estimate_se, m.confidence, m.trend,
            m.solved_count, m.recent_solve_count, m.last_practiced_at,
            m.last_activity_at,
            (select count(*) from topics t where t.category_slug = c.slug)::int
              as module_count,
            (select count(*) from topics t
              join topic_mastery tm on tm.topic_id = t.id and tm.user_id = $1
              where t.category_slug = c.slug and tm.stale and tm.solved_count >= 3)::int
              as stale_modules
     from topics c
     left join topic_mastery m on m.topic_id = c.id and m.user_id = $1
     where c.division = 'Category'
     order by c.ordering`,
    [userId],
  );
}

export type CategoryModule = MapTopic & { division: string };

// A category's member modules with their mastery, for the tier ladder.
export async function getCategoryModules(
  userId: number,
  catSlug: string,
): Promise<CategoryModule[]> {
  return q<CategoryModule>(
    `select t.id, t.slug, t.name, t.division, ch.name as chapter,
            m.score, m.rating_estimate, m.confidence, m.trend, m.stale,
            m.solved_count, m.last_practiced_at
     from topics t
     left join topics ch on ch.id = t.parent_id
     left join topic_mastery m on m.topic_id = t.id and m.user_id = $1
     where t.category_slug = $2
       and exists (select 1 from problem_topics pt where pt.topic_id = t.id)
     order by case t.division when 'Bronze' then 0 when 'Silver' then 1
              when 'Gold' then 2 when 'Platinum' then 3 else 4 end, t.ordering`,
    [userId, catSlug],
  );
}

// ---------- dashboard extras ----------

export type Overview = {
  solved_total: number;
  solved_30d: number;
  submissions_total: number;
  active_days_30d: number;
};

export async function getOverview(userId: number): Promise<Overview> {
  const row = await one<Overview>(
    `select
       (select count(distinct problem_id) from submissions
         where user_id = $1 and verdict = 'OK') as solved_total,
       (select count(distinct problem_id) from submissions
         where user_id = $1 and verdict = 'OK'
           and submitted_at > now() - interval '30 days') as solved_30d,
       (select count(*) from submissions where user_id = $1) as submissions_total,
       (select count(distinct submitted_at::date) from submissions
         where user_id = $1 and submitted_at > now() - interval '30 days') as active_days_30d`,
    [userId],
  );
  return row!;
}

export type DayActivity = { day: string; solved: number; failed: number };

// Last 8 weeks of daily activity for the dashboard strip.
export async function getActivityStrip(userId: number): Promise<DayActivity[]> {
  return q<DayActivity>(
    `select d::date::text as day,
            coalesce(count(s.id) filter (where s.verdict = 'OK'), 0)::int as solved,
            coalesce(count(s.id) filter (where s.verdict <> 'OK'), 0)::int as failed
     from generate_series(now()::date - 55, now()::date, '1 day') d
     left join submissions s on s.user_id = $1 and s.submitted_at::date = d::date
     group by 1 order by 1`,
    [userId],
  );
}

export type ReviewItem = MapTopic & {
  division: string;
  reason: "weak" | "stale" | "weak+stale";
  mistakes_30d: number;
};

// The "train continuously" mechanic: weak topics (low score, enough evidence)
// and stale topics (>45d untouched). Mistake concentration raises priority.
export async function getNeedsReview(userId: number, limit = 6): Promise<ReviewItem[]> {
  return q<ReviewItem>(
    `with mistake_topics as (
       select pt.topic_id, count(*)::int as n
       from mistakes mi
       join attempts a on a.id = mi.attempt_id and a.user_id = $1
       join problem_topics pt on pt.problem_id = a.problem_id
       where mi.created_at > now() - interval '30 days'
       group by pt.topic_id
     )
     select t.id, t.slug, t.name, t.division, ch.name as chapter,
            m.score, m.rating_estimate, m.confidence, m.trend, m.stale,
            m.solved_count, m.last_practiced_at,
            coalesce(mt.n, 0) as mistakes_30d,
            case when m.score < 40 and m.stale then 'weak+stale'
                 when m.score < 40 then 'weak' else 'stale' end as reason
     from topic_mastery m
     join topics t on t.id = m.topic_id and t.parent_id is not null
     join topics ch on ch.id = t.parent_id
     left join mistake_topics mt on mt.topic_id = t.id
     where m.user_id = $1 and t.division <> 'General'
       and ((m.score < 40 and m.confidence >= 0.25) or (m.stale and m.solved_count >= 3))
     order by (case when m.score < 40 then 40 - m.score else 0 end)
              + (case when m.stale then 20 else 0 end)
              + coalesce(mt.n, 0) * 5 desc
     limit $2`,
    [userId, limit],
  );
}

export type RecentSubmission = {
  id: number;
  verdict: string | null;
  submitted_at: string;
  title: string | null;
  external_id: string | null;
  url: string | null;
  rating: number | null;
};

export async function getRecentSubmissions(
  userId: number,
  limit = 10,
): Promise<RecentSubmission[]> {
  return q<RecentSubmission>(
    `select s.id, s.verdict, s.submitted_at, p.title, p.external_id, p.url, p.rating
     from submissions s
     left join problem_catalog p on p.id = s.problem_id
     where s.user_id = $1
     order by s.submitted_at desc limit $2`,
    [userId, limit],
  );
}

export type SyncState = {
  status: string | null;
  message: string | null;
  last_run_at: string | null;
  submissions_total: number;
};

export async function getSyncState(userId: number): Promise<SyncState | null> {
  return one<SyncState>(
    `select ss.status, ss.message, ss.last_run_at,
            (select count(*) from submissions where user_id = $1)::int as submissions_total
     from sync_state ss where ss.user_id = $1 and ss.source = 'cf_api'`,
    [userId],
  );
}

// ---------- topic detail ----------

// One observation behind an estimate. `push` = weight * (outcome - p_solve):
// how hard this problem moved the fit, and in which direction.
export type Contributor = {
  problem_id: number;
  external_id: string;
  title: string;
  url: string;
  rating: number;
  effective_difficulty: number;
  solved: boolean;
  in_contest: boolean;
  wa_count: number;
  at: string;
  weight: number;
  p_solve: number;
  push: number;
};

// The score factors the worker actually used. Never re-derive these in the
// UI — that is how the displayed breakdown drifts from the stored score.
export type Factors = {
  level: number;
  evidence: number;
  freshness: number;
  heat_mass: number;
  idle_days: number | null;
  theta_engaged: number;
  your_level: number;
  selection_offset: number;
  n_obs: number;
  n_solved: number;
  push_total: number;
};

export type TopicDetail = {
  id: number;
  slug: string;
  name: string;
  division: string;
  parent_id: number | null;
  category_slug: string | null;
  chapter: string | null;
  chapter_slug: string | null;
  score: number | null;
  rating_estimate: number | null;
  estimate_se: number | null;
  n_eff: number | null;
  confidence: number | null;
  trend: number | null;
  stale: boolean | null;
  solved_count: number | null;
  recent_solve_count: number | null;
  last_practiced_at: string | null;
  last_activity_at: string | null;
  contributors: Contributor[] | null;
  factors: Factors | null;
};

export async function getTopicDetail(
  userId: number,
  slug: string,
): Promise<TopicDetail | null> {
  return one<TopicDetail>(
    `select t.id, t.slug, t.name, t.division, t.parent_id, t.category_slug,
            ch.name as chapter, ch.slug as chapter_slug,
            m.score, m.rating_estimate, m.estimate_se, m.n_eff,
            m.confidence, m.trend, m.stale,
            m.solved_count, m.recent_solve_count, m.last_practiced_at,
            m.last_activity_at, m.contributors, m.factors
     from topics t
     left join topics ch on ch.id = t.parent_id
     left join topic_mastery m on m.topic_id = t.id and m.user_id = $1
     where t.slug = $2`,
    [userId, slug],
  );
}

export async function getChildTopics(
  userId: number,
  parentId: number,
): Promise<MapTopic[]> {
  return q<MapTopic>(
    `select t.id, t.slug, t.name, '' as chapter,
            m.score, m.rating_estimate, m.confidence, m.trend, m.stale,
            m.solved_count, m.last_practiced_at
     from topics t
     left join topic_mastery m on m.topic_id = t.id and m.user_id = $1
     where t.parent_id = $2
       and exists (select 1 from problem_topics pt where pt.topic_id = t.id)
     order by t.ordering`,
    [userId, parentId],
  );
}

export type CatalogProblem = {
  id: number;
  external_id: string;
  title: string;
  url: string;
  rating: number | null;
  difficulty_label: string | null;
  curated: boolean;
};

// Unsolved active CF problems in a topic (module: its own; chapter: children
// too), curated first, closest to the just-above-mastery target.
export async function getUnsolvedInTopic(
  userId: number,
  topicId: number,
  targetRating: number,
  limit = 12,
): Promise<CatalogProblem[]> {
  return q<CatalogProblem>(
    `select p.id, p.external_id, p.title, p.url, p.rating, p.difficulty_label,
            bool_or(pt.origin = 'usaco_guide') as curated
     from problem_catalog p
     join problem_topics pt on pt.problem_id = p.id
     where pt.topic_id in (
             select $2::bigint union
             select id from topics where parent_id = $2::bigint union
             select t2.id from topics t2, topics me
               where me.id = $2::bigint and t2.category_slug = me.slug)
       and p.active and p.source = 'cf'
       and not exists (select 1 from submissions s
                       where s.user_id = $1 and s.problem_id = p.id and s.verdict = 'OK')
     group by p.id
     order by bool_or(pt.origin = 'usaco_guide') desc,
              abs(coalesce(p.rating, 0) - $3) asc
     limit $4`,
    [userId, topicId, targetRating, limit],
  );
}

// ---------- solve view / recommender ----------

export type Recommendation = CatalogProblem & {
  tags: string[];
  topic_slug: string;
  topic_name: string;
  target_rating: number;
  why: string;
};

// The topic grind recommender (§ milestone 5): unsolved problems in the topic,
// rating in a just-above-mastery band, curated (usaco.guide) first, closest to
// target. When no topic is given, the topic itself is chosen by need: weak or
// stale first, weighted by where recent mistakes concentrate.
export async function recommend(
  userId: number,
  topicSlug: string | null,
  skip = 0,
): Promise<Recommendation | null> {
  let slug = topicSlug;
  let why = "";

  if (!slug) {
    const review = await getNeedsReview(userId, 1);
    if (review.length > 0) {
      slug = review[0].slug;
      why =
        review[0].reason === "stale"
          ? `${review[0].name} is going stale — last practiced ${review[0].last_practiced_at ? new Date(review[0].last_practiced_at).toLocaleDateString() : "a while ago"}.`
          : `${review[0].name} is one of your weakest topics right now.`;
    } else {
      const top = await one<{ slug: string; name: string }>(
        `select t.slug, t.name from topic_mastery m
         join topics t on t.id = m.topic_id and t.parent_id is not null
         where m.user_id = $1 and t.division <> 'General'
         order by m.last_practiced_at asc nulls first limit 1`,
        [userId],
      );
      if (top) {
        slug = top.slug;
        why = `${top.name} hasn't been practiced in the longest.`;
      }
    }
  }
  if (!slug) return null;

  const row = await one<Recommendation>(
    `with topic as (
       select id, slug, name from topics where slug = $2
     ), target as (
       select coalesce(
         (select rating_estimate from topic_mastery m
           join topic t on t.id = m.topic_id where m.user_id = $1),
         (select coalesce(cf_rating, 1200) from users where id = $1)
       )::int as est
     ), cands as (
       select p.id, p.external_id, p.title, p.url, p.rating, p.difficulty_label,
              p.tags, bool_or(pt.origin = 'usaco_guide') as curated
       from problem_catalog p
       join problem_topics pt on pt.problem_id = p.id
       where pt.topic_id in (
               select id from topic union
               select id from topics where parent_id = (select id from topic) union
               select id from topics where category_slug = $2)
         and p.active and p.source = 'cf' and p.rating is not null
         and not exists (select 1 from submissions s
                         where s.user_id = $1 and s.problem_id = p.id and s.verdict = 'OK')
       group by p.id
     )
     select c.*, t.slug as topic_slug, t.name as topic_name,
            (select est from target) as target_rating
     from cands c, topic t
     where c.rating between (select est from target) - 100
                        and (select est from target) + 300
     order by c.curated desc,
              abs(c.rating - ((select est from target) + 150)),
              c.external_id desc
     limit 1 offset $3`,
    [userId, slug, skip],
  );
  if (!row) return null;
  row.why =
    why ||
    `Rated ${row.rating} — just above your ~${row.target_rating} estimate in ${row.topic_name}.`;
  if (why) {
    row.why += ` Rated ${row.rating}, just above your ~${row.target_rating} estimate.`;
  }
  return row;
}

// Module topics for the solve view's topic picker, grouped by category
// client-side (each category also gets an "all of it" option).
export type PickerTopic = {
  slug: string;
  name: string;
  division: string;
  category_slug: string | null;
  score: number | null;
  stale: boolean | null;
};

export async function getPickerTopics(userId: number): Promise<PickerTopic[]> {
  return q<PickerTopic>(
    `select t.slug, t.name, t.division, t.category_slug, m.score, m.stale
     from topics t
     left join topic_mastery m on m.topic_id = t.id and m.user_id = $1
     where t.category_slug is not null
       and exists (select 1 from problem_topics pt
                   where pt.topic_id = t.id
                     and exists (select 1 from problem_catalog p
                                 where p.id = pt.problem_id and p.active))
     order by case t.division when 'Bronze' then 1 when 'Silver' then 2
              when 'Gold' then 3 when 'Platinum' then 4 else 5 end,
              t.ordering`,
    [userId],
  );
}

// ---------- attempts ----------

export type OpenAttempt = {
  id: number;
  problem_id: number;
  started_at: string;
  title: string;
  external_id: string;
  url: string;
  rating: number | null;
};

export async function getOpenAttempt(userId: number): Promise<OpenAttempt | null> {
  return one<OpenAttempt>(
    `select a.id, a.problem_id, a.started_at, p.title, p.external_id, p.url, p.rating
     from attempts a join problem_catalog p on p.id = a.problem_id
     where a.user_id = $1 and a.ended_at is null
     order by a.started_at desc limit 1`,
    [userId],
  );
}

// Judge's view of an attempt window — used after "Got AC / Gave up" to show
// what actually happened (reconciliation rule, §3).
export async function getAttemptVerdicts(userId: number, attemptId: number) {
  return q<{ verdict: string | null; submitted_at: string }>(
    `select s.verdict, s.submitted_at
     from attempts a
     join submissions s on s.user_id = a.user_id and s.problem_id = a.problem_id
       and s.submitted_at >= a.started_at
       and s.submitted_at <= coalesce(a.ended_at, now())
     where a.id = $1 and a.user_id = $2
     order by s.submitted_at`,
    [attemptId, userId],
  );
}
