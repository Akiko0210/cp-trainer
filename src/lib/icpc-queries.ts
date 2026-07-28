import { one, q } from "./db";

/*
  ICPC practice sets (Kattis). Solve state for these cannot be mirrored — no
  public API, and robots.txt disallows the profile pages — so "solved" means a
  row in `submissions` with source='manual', written either by finishing a
  timed attempt with AC or by an explicit "mark solved". Because those rows
  live in the same table as the CF mirror, every existing solved-check works
  unchanged; `source` keeps them auditable.
*/

export type ContestSet = {
  id: number;
  slug: string;
  name: string;
  level: string;
  region: string | null;
  series: string | null;
  year: number | null;
  url: string;
  problem_count: number;
  solved_count: number;
  min_difficulty: number | null;
  max_difficulty: number | null;
  last_session_at: string | null;
  sessions: number;
};

export async function getContestSets(
  userId: number,
  filters: { level?: string; region?: string; series?: string; year?: number } = {},
): Promise<ContestSet[]> {
  return q<ContestSet>(
    `select s.id, s.slug, s.name, s.level, s.region, s.series, s.year, s.url,
            count(sp.problem_id)::int as problem_count,
            count(*) filter (where sol.problem_id is not null)::int as solved_count,
            min(p.kattis_difficulty) as min_difficulty,
            max(p.kattis_difficulty) as max_difficulty,
            (select max(cs.started_at) from contest_sessions cs
              where cs.set_id = s.id and cs.user_id = $1) as last_session_at,
            (select count(*) from contest_sessions cs
              where cs.set_id = s.id and cs.user_id = $1)::int as sessions
     from contest_sets s
     join contest_set_problems sp on sp.set_id = s.id
     join problem_catalog p on p.id = sp.problem_id
     left join (
       select distinct problem_id from submissions
       where user_id = $1 and verdict = 'OK'
     ) sol on sol.problem_id = sp.problem_id
     where ($2::text is null or s.level = $2)
       and ($3::text is null or s.region = $3)
       and ($4::text is null or s.series = $4)
       and ($5::int is null or s.year = $5)
     group by s.id
     order by s.year desc nulls last, s.name`,
    [
      userId,
      filters.level ?? null,
      filters.region ?? null,
      filters.series ?? null,
      filters.year ?? null,
    ],
  );
}

export type SetFilterOptions = {
  levels: { level: string; n: number }[];
  years: number[];
  regions: { region: string; n: number }[];
  series: { series: string; region: string; level: string; n: number }[];
};

export async function getSetFilterOptions(): Promise<SetFilterOptions> {
  const [levels, years, regions, series] = await Promise.all([
    q<{ level: string; n: number }>(
      `select level, count(*)::int as n from contest_sets group by level`,
    ),
    q<{ year: number }>(
      `select distinct year from contest_sets where year is not null order by year desc`,
    ),
    q<{ region: string; n: number }>(
      `select region, count(*)::int as n from contest_sets
       where region is not null group by region order by n desc`,
    ),
    q<{ series: string; region: string; level: string; n: number }>(
      `select series, min(region) as region, min(level) as level, count(*)::int as n
       from contest_sets where series is not null
       group by series order by series`,
    ),
  ]);
  return { levels, years: years.map((r) => r.year), regions, series };
}

// The user's own ladder: how much of each rung they've actually practised.
export type LadderRung = {
  level: string;
  sets: number;
  problems: number;
  solved: number;
  sessions: number;
};

export async function getLadder(userId: number): Promise<LadderRung[]> {
  return q<LadderRung>(
    `select s.level,
            count(distinct s.id)::int as sets,
            count(sp.problem_id)::int as problems,
            count(*) filter (where sol.problem_id is not null)::int as solved,
            (select count(*) from contest_sessions cs
               join contest_sets s2 on s2.id = cs.set_id
              where cs.user_id = $1 and s2.level = s.level)::int as sessions
     from contest_sets s
     join contest_set_problems sp on sp.set_id = s.id
     left join (
       select distinct problem_id from submissions
       where user_id = $1 and verdict = 'OK'
     ) sol on sol.problem_id = sp.problem_id
     where s.level <> 'practice'
     group by s.level`,
    [userId],
  );
}

export type SetProblem = {
  id: number;
  external_id: string;
  title: string;
  url: string;
  kattis_difficulty: number | null;
  ordering: number | null;
  solved: boolean;
  attempt_id: number | null;
  attempt_started_at: string | null;
  attempt_ended_at: string | null;
  attempt_outcome: string | null;
};

export async function getSetDetail(userId: number, slug: string) {
  const set = await one<ContestSet>(
    `select s.*, count(sp.problem_id)::int as problem_count,
            0 as solved_count, null::real as min_difficulty,
            null::real as max_difficulty, null::timestamptz as last_session_at
     from contest_sets s
     join contest_set_problems sp on sp.set_id = s.id
     where s.slug = $1 group by s.id`,
    [slug],
  );
  if (!set) return null;

  // Attempts are scoped to the CURRENT open session when there is one, so a
  // fresh virtual contest starts with a clean board.
  const problems = await q<SetProblem>(
    `select p.id, p.external_id, p.title, p.url, p.kattis_difficulty, sp.ordering,
            exists (select 1 from submissions s
                    where s.user_id = $1 and s.problem_id = p.id
                      and s.verdict = 'OK') as solved,
            a.id as attempt_id, a.started_at as attempt_started_at,
            a.ended_at as attempt_ended_at, a.outcome as attempt_outcome
     from contest_set_problems sp
     join problem_catalog p on p.id = sp.problem_id
     left join attempts a on a.problem_id = p.id and a.user_id = $1
       and a.session_id = (select id from contest_sessions
                           where user_id = $1 and ended_at is null)
     where sp.set_id = $2
     order by sp.ordering nulls last, p.external_id`,
    [userId, set.id],
  );
  return { set, problems };
}

export type OpenSession = {
  id: number;
  set_id: number;
  set_slug: string;
  set_name: string;
  started_at: string;
  duration_s: number;
};

export async function getOpenSession(userId: number): Promise<OpenSession | null> {
  return one<OpenSession>(
    `select cs.id, cs.set_id, s.slug as set_slug, s.name as set_name,
            cs.started_at, cs.duration_s
     from contest_sessions cs join contest_sets s on s.id = cs.set_id
     where cs.user_id = $1 and cs.ended_at is null`,
    [userId],
  );
}

export type SessionResult = {
  problem_id: number;
  title: string;
  url: string;
  kattis_difficulty: number | null;
  outcome: string | null;
  solved: boolean;
  // seconds from the contest start to the AC, i.e. the ICPC-style split
  solved_at_s: number | null;
  minutes_spent: number | null;
  tags: string[];
};

export async function getSessionResults(
  userId: number,
  sessionId: number,
): Promise<SessionResult[]> {
  return q<SessionResult>(
    `select p.id as problem_id, p.title, p.url, p.kattis_difficulty,
            a.outcome, a.outcome = 'ac' as solved,
            case when a.outcome = 'ac'
              then extract(epoch from a.ended_at - cs.started_at)::int end as solved_at_s,
            (extract(epoch from coalesce(a.ended_at, now()) - a.started_at) / 60)::int
              as minutes_spent,
            coalesce(array_agg(mi.tag) filter (where mi.tag is not null), '{}') as tags
     from contest_sessions cs
     join attempts a on a.session_id = cs.id
     join problem_catalog p on p.id = a.problem_id
     left join mistakes mi on mi.attempt_id = a.id
     where cs.id = $1 and cs.user_id = $2
     group by p.id, p.title, p.url, p.kattis_difficulty, a.outcome, a.ended_at,
              a.started_at, cs.started_at
     order by solved desc, solved_at_s nulls last`,
    [sessionId, userId],
  );
}

export type PastSession = {
  id: number;
  set_slug: string;
  set_name: string;
  started_at: string;
  duration_s: number;
  ended_at: string | null;
  solved: number;
  attempted: number;
};

export async function getPastSessions(
  userId: number,
  limit = 8,
): Promise<PastSession[]> {
  return q<PastSession>(
    `select cs.id, s.slug as set_slug, s.name as set_name, cs.started_at,
            cs.duration_s, cs.ended_at,
            count(a.id) filter (where a.outcome = 'ac')::int as solved,
            count(a.id)::int as attempted
     from contest_sessions cs
     join contest_sets s on s.id = cs.set_id
     left join attempts a on a.session_id = cs.id
     where cs.user_id = $1 and cs.ended_at is not null
     group by cs.id, s.slug, s.name
     order by cs.started_at desc limit $2`,
    [userId, limit],
  );
}
