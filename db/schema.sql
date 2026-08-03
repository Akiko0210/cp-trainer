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

-- level/region/series place a set on the real ICPC ladder; the classifier is
-- worker/icpc_taxonomy.py and is a pure function of `name`, so re-deriving
-- these never requires re-crawling.
create table if not exists contest_sets (
  id     bigserial primary key,
  source text not null default 'kattis',
  slug   text not null,                      -- the /problem-sources/<slug> name
  name   text not null,
  kind   text not null default 'other',      -- legacy; superseded by `level`
  level  text not null default 'other',      -- qualifier|regional|championship|world-finals|practice
  region text,                               -- North America|Europe|Asia|Global|Other
  series text,                               -- subgroup: Pacific Northwest, NWERC, NAC, ...
  year   int,
  url    text not null,
  unique (source, slug)
);
create index if not exists contest_sets_level_year on contest_sets (level, year desc);
create index if not exists contest_sets_series on contest_sets (series);

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

-- ============================================================================
-- Identity and guilds
--
-- v1 was single-user (`select * from users limit 1`). A shared leaderboard
-- needs real identity: GitHub OAuth (no password hashes stored anywhere), a
-- server-side session table, and a guild.
--
-- These are `alter`s rather than part of `create table users` above so that
-- this file stays replayable over a database created by any earlier version —
-- it is applied by `pnpm db:schema`, which existing installs also re-run.
-- db/migrations/ holds the same changes as an ordered upgrade path.
-- ============================================================================

alter table users add column if not exists github_id        bigint;
alter table users add column if not exists github_login     text;
alter table users add column if not exists avatar_url       text;
alter table users add column if not exists email            text;
alter table users add column if not exists last_seen_at     timestamptz;
-- Exactly one guild per person, so affiliation lives on the user row. That is
-- what lets the guild appear on every page without asking which group is meant.
alter table users add column if not exists guild_id         bigint;
alter table users add column if not exists guild_role       text;
alter table users add column if not exists guild_joined_at  timestamptz;

-- Plain (not partial) unique index: Postgres already allows many NULLs in a
-- unique index, and a PARTIAL index can't be inferred by
-- `on conflict (github_id)`, which is exactly what the sign-in upsert uses.
create unique index if not exists users_github_id on users (github_id);

-- Opaque random token in an HTTP-only cookie; the row is the source of truth
-- so a session can be revoked server-side.
create table if not exists sessions (
  token      text primary key,
  user_id    bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index if not exists sessions_user on sessions (user_id);
create index if not exists sessions_expiry on sessions (expires_at);

create table if not exists guilds (
  id          bigserial primary key,
  slug        text unique not null,
  name        text not null,
  tagline     text,
  invite_code text unique not null,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_guild_id_fkey') then
    -- Deleting a guild empties it rather than deleting its people.
    alter table users add constraint users_guild_id_fkey
      foreign key (guild_id) references guilds(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_guild_role_check') then
    alter table users add constraint users_guild_role_check
      check (guild_role is null or guild_role in ('leader', 'officer', 'member'));
  end if;
end $$;

create index if not exists users_guild on users (guild_id);

-- --- real-time --------------------------------------------------------------
-- Writers NOTIFY; a single LISTEN connection fans out to every open SSE
-- stream. With a worker configured that listener lives in the worker
-- (worker/broadcast.py) and browsers stream from it directly; otherwise the
-- web app holds one per Node process (src/lib/realtime.ts). Either way a
-- writer publishes to every open leaderboard without knowing who is watching.
-- Payloads name the guild so a stream can filter by it. No guild, no traffic.

create or replace function notify_standings_change() returns trigger as $$
declare
  gid bigint;
begin
  select guild_id into gid from users where id = new.user_id;
  if gid is null then return new; end if;
  perform pg_notify('standings', json_build_object(
    'type', 'mastery', 'guild_id', gid, 'user_id', new.user_id,
    'topic_id', new.topic_id, 'score', new.score, 'estimate', new.rating_estimate
  )::text);
  return new;
end;
$$ language plpgsql;

drop trigger if exists topic_mastery_notify on topic_mastery;
create trigger topic_mastery_notify
  after insert or update on topic_mastery
  for each row execute function notify_standings_change();

create or replace function notify_solve() returns trigger as $$
declare
  gid bigint;
begin
  if new.verdict <> 'OK' then return new; end if;
  select guild_id into gid from users where id = new.user_id;
  if gid is null then return new; end if;
  perform pg_notify('standings', json_build_object(
    'type', 'solve', 'guild_id', gid, 'user_id', new.user_id,
    'problem_id', new.problem_id
  )::text);
  return new;
end;
$$ language plpgsql;

drop trigger if exists submissions_notify on submissions;
create trigger submissions_notify
  after insert on submissions
  for each row execute function notify_solve();

create or replace function notify_roster_change() returns trigger as $$
begin
  if new.guild_id is not null then
    perform pg_notify('standings', json_build_object(
      'type', 'roster', 'guild_id', new.guild_id, 'user_id', new.id
    )::text);
  end if;
  -- Someone leaving has to reach the guild they left, which is no longer on
  -- their row — hence the second notify.
  if tg_op = 'UPDATE'
     and old.guild_id is not null
     and old.guild_id is distinct from new.guild_id then
    perform pg_notify('standings', json_build_object(
      'type', 'roster', 'guild_id', old.guild_id, 'user_id', new.id
    )::text);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists users_guild_notify on users;
-- Narrow WHEN clause: users rows are also touched by every sign-in
-- (last_seen_at), and that must not wake up every open leaderboard.
create trigger users_guild_notify
  after update on users
  for each row
  when (old.guild_id is distinct from new.guild_id
        or old.ability_estimate is distinct from new.ability_estimate)
  execute function notify_roster_change();
