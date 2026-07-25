-- CP Trainer schema (handoff §3).
-- Spine: objective record (submissions, mirrored from the judge) and subjective
-- record (attempts + mistakes, supplied by the user) are separate tables,
-- reconciled by (user_id, problem_id, time window) — never merged.
-- Every user-owned table carries user_id: multi-tenant from day one.

create table if not exists users (
  id            bigserial primary key,
  cf_handle     text unique,
  display_name  text,
  -- baseline from CF user.info; used to map rating_estimate -> 0-100 score
  cf_rating     int,
  cf_max_rating int,
  cf_rank       text,
  -- Overall ability fitted from in-contest performance (worker/estimator.py).
  -- Calibrated against CF's own scale, so it is comparable to cf_rating but
  -- reflects "can solve during a round" rather than rank/speed.
  ability_estimate real,
  ability_se       real,
  -- How much the problems the user CHOOSES to engage with inflate an estimate
  -- versus the full contest sets. Subtracted from per-topic fits so topic
  -- estimates land on the same calibrated scale. See mastery.py.
  selection_offset real,
  created_at    timestamptz not null default now()
);

-- Seeded from usaco.guide module tree (divisions -> modules/topics), plus
-- canonical category rows (division = 'Category', slug 'cat-*'); each module
-- carries category_slug -> its major ICPC category (see worker/categories.py).
create table if not exists topics (
  id            bigserial primary key,
  slug          text unique not null,
  name          text not null,
  parent_id     bigint references topics(id),
  division      text,
  ordering      int,
  category_slug text
);

-- Seeded from usaco.guide curated lists + CF problemset.
-- 'active' = usable by the recommender (v1: CF-linked only; Kattis rows kept inactive).
create table if not exists problem_catalog (
  id               bigserial primary key,
  source           text not null default 'cf',        -- 'cf' | 'kattis' | 'cses' ...
  external_id      text not null,                     -- e.g. '1234A' for cf
  title            text not null,
  url              text not null,
  contest_id       int,                               -- CF contest, for full-set lookups
  rating           int,                               -- CF difficulty, nullable
  tags             text[] not null default '{}',
  difficulty_label text,                              -- usaco.guide Very Easy..Very Hard
  kattis_difficulty real,                             -- Kattis 1.0..9.9 scale

  active           boolean not null default true,
  unique (source, external_id)
);

create table if not exists problem_topics (
  problem_id bigint not null references problem_catalog(id) on delete cascade,
  topic_id   bigint not null references topics(id) on delete cascade,
  origin     text not null check (origin in ('usaco_guide', 'cf_tag')),
  primary key (problem_id, topic_id, origin)
);

-- OBJECTIVE: mirrored from the Codeforces API. The judge wins on these facts.
create table if not exists submissions (
  id                     bigserial primary key,
  user_id                bigint not null references users(id),
  problem_id             bigint references problem_catalog(id),
  -- CF author.participantType: CONTESTANT / VIRTUAL / OUT_OF_COMPETITION are
  -- first-encounter timed attempts (the regime CF problem ratings are
  -- calibrated for); PRACTICE means unlimited time and editorials available.
  -- The estimator weighs these very differently.
  participant_type       text,
  verdict                text,               -- OK, WRONG_ANSWER, TIME_LIMIT_EXCEEDED, ...
  language               text,
  submitted_at           timestamptz not null,
  time_ms                int,
  memory_bytes           bigint,
  -- 'cf_api' = mirrored from the judge (objective).
  -- 'manual' = the user asserting a solve on a judge we cannot read (Kattis).
  --            Kept in this table so every "is it solved" query works unchanged,
  --            but distinguishable by source for auditing.
  source                 text not null default 'cf_api',
  external_submission_id bigint not null,
  unique (user_id, source, external_submission_id)
);
create index if not exists submissions_user_problem_time
  on submissions (user_id, problem_id, submitted_at);
create index if not exists submissions_user_time
  on submissions (user_id, submitted_at desc);

-- ---------------------------------------------------------------------------
-- ICPC practice sets (Kattis). Archival contest problem sets; see
-- worker/seed_icpc.py. Kattis has no public API and robots.txt disallows
-- /users and /submissions, so solve state can never be mirrored — it comes
-- from the app's own timer, or from an explicit "mark solved".
-- ---------------------------------------------------------------------------

create table if not exists contest_sets (
  id     bigserial primary key,
  source text not null default 'kattis',
  slug   text not null,                      -- the /problem-sources/<slug> name
  name   text not null,
  kind   text not null default 'other',      -- world-finals|regional|qualifier|practice|other
  region text,
  year   int,
  url    text not null,
  unique (source, slug)
);
create index if not exists contest_sets_kind_year on contest_sets (kind, year desc);

create table if not exists contest_set_problems (
  set_id     bigint not null references contest_sets(id) on delete cascade,
  problem_id bigint not null references problem_catalog(id) on delete cascade,
  ordering   int,
  primary key (set_id, problem_id)
);

-- One virtual-contest run over a set: a single master clock, with each
-- problem worked inside it recorded as a normal `attempt` (attempts.session_id).
create table if not exists contest_sessions (
  id         bigserial primary key,
  user_id    bigint not null references users(id),
  set_id     bigint not null references contest_sets(id) on delete cascade,
  started_at timestamptz not null default now(),
  duration_s int not null default 18000,     -- 5 hours, the ICPC standard
  ended_at   timestamptz
);
create index if not exists contest_sessions_user on contest_sessions (user_id, started_at desc);
-- At most one open session per user.
create unique index if not exists contest_sessions_one_open
  on contest_sessions (user_id) where ended_at is null;

-- SUBJECTIVE: one timed session. The user supplies only what the judge cannot
-- know: when thinking started, and (via mistakes) why a submission was wrong.
-- WA counts / first-submit / AC times are DERIVED from submissions in
-- [started_at, ended_at] by the worker's reconcile step, not user-reported.
create table if not exists attempts (
  id                     bigserial primary key,
  user_id                bigint not null references users(id),
  problem_id             bigint not null references problem_catalog(id),
  started_at             timestamptz not null,
  ended_at               timestamptz,
  outcome                text check (outcome in ('ac', 'gave_up')), -- null while open
  time_to_first_submit_s int,
  debug_time_s           int,
  -- Set when this attempt happened inside a virtual contest run.
  session_id             bigint references contest_sessions(id) on delete set null,
  source                 text not null default 'timer'
);
create index if not exists attempts_user_time on attempts (user_id, started_at desc);

-- Structured post-mortem, fixed taxonomy (§6.2), attached to an attempt.
create table if not exists mistakes (
  id         bigserial primary key,
  attempt_id bigint not null references attempts(id) on delete cascade,
  tag        text not null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists mistakes_attempt on mistakes (attempt_id);

-- DERIVED, materialized by the worker for fast dashboard reads.
-- contributors = the solved problems behind the score (transparency requirement).
create table if not exists topic_mastery (
  user_id            bigint not null references users(id),
  topic_id           bigint not null references topics(id) on delete cascade,
  score              real,
  rating_estimate    real,
  -- standard error of rating_estimate (Elo points) and the count of
  -- recency-weighted observations behind it; see worker/estimator.py
  estimate_se        real,
  n_eff              real,
  -- last submission of ANY verdict; drives freshness/stale (a failed attempt
  -- yesterday still means you touched the topic). last_practiced_at stays
  -- "last successful solve".
  last_activity_at   timestamptz,
  confidence         real,
  trend              int,          -- -1 | 0 | 1 vs previous window
  stale              boolean not null default false,
  solved_count       int not null default 0,
  recent_solve_count int not null default 0,
  last_practiced_at  timestamptz,
  contributors       jsonb not null default '[]',
  -- The score factors ACTUALLY used (level/evidence/freshness + the fit's
  -- inputs), so the UI can render the real arithmetic instead of re-deriving
  -- the formula and drifting out of sync with the worker.
  factors            jsonb not null default '{}',
  computed_at        timestamptz not null default now(),
  primary key (user_id, topic_id)
);

create table if not exists sync_state (
  user_id                   bigint not null references users(id),
  source                    text not null,
  last_synced_submission_id bigint,
  last_run_at               timestamptz,
  status                    text,   -- 'ok' | 'running' | 'error'
  message                   text,
  primary key (user_id, source)
);
