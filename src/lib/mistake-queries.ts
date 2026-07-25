import { one, q } from "./db";

// ---------- mistake analytics (handoff §6.2) ----------
// Subjective layer: tagged post-mortems (mistakes ⨝ attempts).
// Objective layer: verdict mix straight from the judge mirror — useful from
// day one, before any attempts are tagged.

export type TagCount = { tag: string; n: number; n30: number };

export async function getTagCounts(userId: number): Promise<TagCount[]> {
  return q<TagCount>(
    `select mi.tag,
            count(*)::int as n,
            count(*) filter (where mi.created_at > now() - interval '30 days')::int as n30
     from mistakes mi
     join attempts a on a.id = mi.attempt_id
     where a.user_id = $1
     group by mi.tag order by n desc`,
    [userId],
  );
}

// Topic grouping for analytics = the canonical categories (8 major ICPC
// areas), far more readable than usaco.guide's chapter names.

// The headline the feature exists for:
// "41% of your WAs this month are edge-case misses, concentrated in graph problems."
export type Headline = {
  tag: string;
  share: number; // 0..1 of this month's tagged mistakes
  total: number;
  top_chapter: string | null;
  chapter_share: number | null;
};

export async function getHeadline(userId: number): Promise<Headline | null> {
  const top = await one<{ tag: string; n: number; total: number }>(
    `with month as (
       select mi.tag from mistakes mi
       join attempts a on a.id = mi.attempt_id
       where a.user_id = $1 and mi.created_at > now() - interval '30 days'
     )
     select tag, count(*)::int as n, (select count(*) from month)::int as total
     from month group by tag order by n desc limit 1`,
    [userId],
  );
  if (!top || top.total < 3) return null; // too little data for a claim

  const chapter = await one<{ chapter: string; n: number; total: number }>(
    `with tagged as (
       select a.problem_id from mistakes mi
       join attempts a on a.id = mi.attempt_id
       where a.user_id = $1 and mi.tag = $2
         and mi.created_at > now() - interval '30 days'
     )
     select c.name as chapter, count(distinct tg.problem_id)::int as n,
            (select count(*) from tagged)::int as total
     from tagged tg
     join problem_topics pt on pt.problem_id = tg.problem_id
     join topics t on t.id = pt.topic_id and t.category_slug is not null
     join topics c on c.slug = t.category_slug
     group by c.name order by n desc limit 1`,
    [userId, top.tag],
  );
  return {
    tag: top.tag,
    share: top.n / top.total,
    total: top.total,
    top_chapter: chapter?.chapter ?? null,
    chapter_share: chapter && chapter.total > 0 ? chapter.n / chapter.total : null,
  };
}

// tag × chapter matrix (top chapters by mistake volume).
export type MatrixCell = { tag: string; chapter: string; n: number };

export async function getTagTopicMatrix(userId: number): Promise<MatrixCell[]> {
  return q<MatrixCell>(
    `with cells as (
       select mi.tag, c.name as chapter, count(distinct mi.id)::int as n
       from mistakes mi
       join attempts a on a.id = mi.attempt_id and a.user_id = $1
       join problem_topics pt on pt.problem_id = a.problem_id
       join topics t on t.id = pt.topic_id and t.category_slug is not null
       join topics c on c.slug = t.category_slug
       group by mi.tag, c.name
     ), top_chapters as (
       select chapter from cells group by chapter
       order by sum(n) desc limit 6
     )
     select * from cells where chapter in (select chapter from top_chapters)
     order by tag, chapter`,
    [userId],
  );
}

// Weekly trend of the top 5 tags, last 12 weeks.
export type TrendPoint = { week: string; tag: string; n: number };

export async function getTagTrend(userId: number): Promise<TrendPoint[]> {
  return q<TrendPoint>(
    `with top_tags as (
       select mi.tag from mistakes mi join attempts a on a.id = mi.attempt_id
       where a.user_id = $1 group by mi.tag order by count(*) desc limit 5
     )
     select to_char(date_trunc('week', mi.created_at), 'YYYY-MM-DD') as week,
            mi.tag, count(*)::int as n
     from mistakes mi
     join attempts a on a.id = mi.attempt_id and a.user_id = $1
     where mi.tag in (select tag from top_tags)
       and mi.created_at > now() - interval '12 weeks'
     group by 1, 2
     order by 1`,
    [userId],
  );
}

// Objective: monthly verdict mix from the judge mirror, last 6 months.
export type VerdictMonth = {
  month: string;
  ok: number;
  wa: number;
  tle: number;
  other: number;
};

export async function getVerdictTrend(userId: number): Promise<VerdictMonth[]> {
  return q<VerdictMonth>(
    `select to_char(date_trunc('month', submitted_at), 'YYYY-MM') as month,
            count(*) filter (where verdict = 'OK')::int as ok,
            count(*) filter (where verdict = 'WRONG_ANSWER')::int as wa,
            count(*) filter (where verdict in ('TIME_LIMIT_EXCEEDED','MEMORY_LIMIT_EXCEEDED'))::int as tle,
            count(*) filter (where verdict not in
              ('OK','WRONG_ANSWER','TIME_LIMIT_EXCEEDED','MEMORY_LIMIT_EXCEEDED'))::int as other
     from submissions
     where user_id = $1 and submitted_at > now() - interval '6 months'
     group by 1 order by 1`,
    [userId],
  );
}

// Objective: which chapters generate the most failed submissions (30d).
export type FailTopic = { chapter: string; slug: string; fails: number; total: number };

export async function getFailByTopic(userId: number): Promise<FailTopic[]> {
  return q<FailTopic>(
    `select c.name as chapter, replace(c.slug, 'cat-', '') as slug,
            count(distinct s.id) filter (where s.verdict <> 'OK')::int as fails,
            count(distinct s.id)::int as total
     from submissions s
     join problem_topics pt on pt.problem_id = s.problem_id
     join topics t on t.id = pt.topic_id and t.category_slug is not null
     join topics c on c.slug = t.category_slug
     where s.user_id = $1 and s.submitted_at > now() - interval '30 days'
     group by c.name, c.slug
     having count(distinct s.id) >= 5
        and count(distinct s.id) filter (where s.verdict <> 'OK') > 0
     order by count(distinct s.id) filter (where s.verdict <> 'OK')::float
              / count(distinct s.id) desc
     limit 8`,
    [userId],
  );
}

// Attempts with their tags, for the recent post-mortems list.
export type TaggedAttempt = {
  id: number;
  started_at: string;
  outcome: string | null;
  title: string;
  url: string;
  rating: number | null;
  tags: string[];
  note: string | null;
};

export async function getRecentPostMortems(userId: number): Promise<TaggedAttempt[]> {
  return q<TaggedAttempt>(
    `select a.id, a.started_at, a.outcome, p.title, p.url, p.rating,
            array_agg(mi.tag order by mi.id) as tags,
            max(mi.note) as note
     from attempts a
     join mistakes mi on mi.attempt_id = a.id
     join problem_catalog p on p.id = a.problem_id
     where a.user_id = $1
     group by a.id, p.title, p.url, p.rating
     order by a.started_at desc limit 8`,
    [userId],
  );
}
