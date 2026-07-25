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
  rating           int,                               -- CF difficulty, nullable
  tags             text[] not null default '{}',
  difficulty_label text,                              -- usaco.guide Very Easy..Very Hard
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
  verdict                text,               -- OK, WRONG_ANSWER, TIME_LIMIT_EXCEEDED, ...
  language               text,
  submitted_at           timestamptz not null,
  time_ms                int,
  memory_bytes           bigint,
  source                 text not null default 'cf_api',
  external_submission_id bigint not null,
  unique (user_id, source, external_submission_id)
);
create index if not exists submissions_user_problem_time
  on submissions (user_id, problem_id, submitted_at);
create index if not exists submissions_user_time
  on submissions (user_id, submitted_at desc);

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
  confidence         real,
  trend              int,          -- -1 | 0 | 1 vs previous window
  stale              boolean not null default false,
  solved_count       int not null default 0,
  recent_solve_count int not null default 0,
  last_practiced_at  timestamptz,
  contributors       jsonb not null default '[]',
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
