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

-- Upcoming-contest mirror (worker/contests.py). Global, not per-user: a
-- contest calendar is the same for everybody. One fetcher per source (CF's
-- official API, AtCoder via kenkoooo, CodeChef's public JSON, clist.by as an
-- opt-in umbrella for judges that permit nothing direct); a refresh replaces
-- only that source's rows, so a moved or cancelled contest simply stops being
-- listed and one judge failing never blanks the others. Readers additionally
-- filter `starts_at > now()` so a stale mirror never shows a started contest
-- as upcoming. Kattis has no contest feed (no API).
create table if not exists upcoming_contests (
  id          bigserial primary key,
  source      text not null default 'cf', -- which fetcher owns the row
  external_id text not null,              -- the judge's own contest id/code
  name        text not null,
  url         text not null,
  starts_at   timestamptz not null,
  duration_s  int not null,
  platform    text not null,              -- display name: Codeforces, AtCoder, LeetCode…
  fetched_at  timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists upcoming_contests_starts on upcoming_contests (starts_at);

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

-- A verdict that BECOMES 'OK' must notify, not only a row inserted as 'OK'.
-- The arena loop (worker/arena.py) sees fresh submissions as TESTING first
-- and upserts the OK over them moments later — an UPDATE, which the
-- insert-only trigger above never fires for. Narrow WHEN: re-syncs re-upsert
-- every page they read, and touching an already-OK row must not re-announce
-- a solve from last month.
drop trigger if exists submissions_verdict_notify on submissions;
create trigger submissions_verdict_notify
  after update of verdict on submissions
  for each row
  when (old.verdict is distinct from new.verdict and new.verdict = 'OK')
  execute function notify_solve();

-- ============================================================================
-- The arena: duels and custom guild contests (db/migrations/005_arena.sql).
--
-- Both answer "who gets it first?" from the submissions mirror the worker
-- already maintains. Nothing here talks to a judge: problems are picked from
-- problem_catalog (pure SQL), and solves are detected by the worker's arena
-- loop (worker/arena.py), which polls only while a duel or contest is live so
-- an idle install still lets a scale-to-zero database sleep.
--
-- Neither carries any rating: nothing writes to topic_mastery or
-- ability_estimate, and losing a duel costs nothing but pride.
-- ============================================================================

create table if not exists duels (
  id            bigserial primary key,
  guild_id      bigint not null references guilds(id) on delete cascade,
  challenger_id bigint not null references users(id) on delete cascade,
  opponent_id   bigint not null references users(id) on delete cascade,
  -- Chosen on accept, not on challenge: picking early would let the
  -- challenger scout the problem while the invitation sits unanswered.
  problem_id    bigint references problem_catalog(id),
  status        text not null default 'pending' check (status in
                  ('pending', 'declined', 'cancelled', 'expired', 'active', 'finished')),
  -- 'solve' (someone got AC), 'forfeit' (someone conceded; the other wins),
  -- 'timeout' (nobody solved it — a draw, winner_id stays null).
  finish_reason text check (finish_reason in ('solve', 'forfeit', 'timeout')),
  winner_id     bigint references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  started_at    timestamptz,
  deadline_at   timestamptz,
  finished_at   timestamptz,
  -- The judge's own timestamp of the winning submission — the fact the race
  -- is decided on.
  winning_submitted_at timestamptz,
  -- 006: 'classic' (one problem, first AC) or 'bullet' (a clock and a ladder
  -- of rounds — see duel_rounds). The alter-table lines further down add
  -- these to an existing install; here they exist for a fresh one.
  mode          text not null default 'classic' check (mode in ('classic', 'bullet')),
  duration_s    int not null default 2700,
  bullet_start_rating int check (bullet_start_rating between 800 and 2400),
  bullet_step   int check (bullet_step in (50, 100, 200))
);
create index if not exists duels_guild_recent on duels (guild_id, created_at desc);
create index if not exists duels_open
  on duels (challenger_id, opponent_id) where status in ('pending', 'active');

create table if not exists guild_contests (
  id            bigserial primary key,
  guild_id      bigint not null references guilds(id) on delete cascade,
  created_by    bigint references users(id) on delete set null,
  name          text not null,
  status        text not null default 'lobby' check (status in
                  ('lobby', 'active', 'finished', 'cancelled')),
  problem_count int not null check (problem_count between 1 and 10),
  rating_min    int not null,
  rating_max    int not null,
  duration_s    int not null,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  ends_at       timestamptz,
  finished_at   timestamptz
);
create index if not exists guild_contests_guild on guild_contests (guild_id, created_at desc);

-- Filled at start, not at creation: problems must exclude what every joined
-- player has already seen, and the field isn't known until the lobby closes.
create table if not exists guild_contest_problems (
  contest_id bigint not null references guild_contests(id) on delete cascade,
  problem_id bigint not null references problem_catalog(id) on delete cascade,
  ordering   int not null,                  -- 0-based; rendered as A, B, C…
  primary key (contest_id, problem_id)
);

create table if not exists guild_contest_players (
  contest_id bigint not null references guild_contests(id) on delete cascade,
  user_id    bigint not null references users(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (contest_id, user_id)
);

create or replace function notify_duel_change() returns trigger as $$
begin
  perform pg_notify('standings', json_build_object(
    'type', 'duel', 'guild_id', new.guild_id, 'duel_id', new.id,
    'status', new.status
  )::text);
  return new;
end;
$$ language plpgsql;

drop trigger if exists duels_notify on duels;
create trigger duels_notify
  after insert or update on duels
  for each row execute function notify_duel_change();

create or replace function notify_guild_contest_change() returns trigger as $$
begin
  perform pg_notify('standings', json_build_object(
    'type', 'contest', 'guild_id', new.guild_id, 'contest_id', new.id,
    'status', new.status
  )::text);
  return new;
end;
$$ language plpgsql;

drop trigger if exists guild_contests_notify on guild_contests;
create trigger guild_contests_notify
  after insert or update on guild_contests
  for each row execute function notify_guild_contest_change();

-- Joining or leaving a lobby has to reach the other viewers of that lobby.
-- The guild id lives on the contest row, hence the lookup.
create or replace function notify_contest_players_change() returns trigger as $$
declare
  cid bigint;
  gid bigint;
begin
  cid := coalesce(new.contest_id, old.contest_id);
  select guild_id into gid from guild_contests where id = cid;
  if gid is not null then
    perform pg_notify('standings', json_build_object(
      'type', 'contest', 'guild_id', gid, 'contest_id', cid, 'status', 'players'
    )::text);
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists guild_contest_players_notify on guild_contest_players;
create trigger guild_contest_players_notify
  after insert or delete on guild_contest_players
  for each row execute function notify_contest_players_change();

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

-- ============================================================================
-- Bullet duels and the battle arena (db/migrations/006_battles.sql).
--
-- Two tournament-style modes on top of the arena. A BULLET duel is a duel
-- with a clock and a ladder of problems: first AC takes the round and scores
-- the problem's rating in points, the next, harder problem opens immediately,
-- the higher total at the bell wins. A BATTLE is a scheduled, host-run
-- tournament: everyone starts at tier 1, a match is one problem at your tier's
-- rating against someone in the same tier, a win climbs a tier, a tie or a
-- loss stays, nobody ever drops; alone at the bottom tier means nobody can
-- ever be paired with you, so you are out, and the last player standing ends
-- it early.
--
-- Everything time-driven lives in arena_sweep(), so the app's lazy per-request
-- sweep and the worker's loop cannot drift apart. The decisions that must be
-- atomic (accept + first round, settle + promote + eliminate) are plpgsql too:
-- sequential statements inside a function see each other, which a
-- data-modifying CTE — one snapshot for the whole statement — does not.
-- Still rating-free: nothing here touches topic_mastery.
-- ============================================================================

-- --- duels: mode ------------------------------------------------------------
alter table duels add column if not exists mode text not null default 'classic'
  check (mode in ('classic', 'bullet'));
-- Classic keeps its 45 minutes; bullet is the challenger's pick (5–30 min).
alter table duels add column if not exists duration_s int not null default 2700;
-- Round k's target is start + step·(k−1), clamped at 3500. Null for classic.
alter table duels add column if not exists bullet_start_rating int
  check (bullet_start_rating between 800 and 2400);
alter table duels add column if not exists bullet_step int
  check (bullet_step in (50, 100, 200));

-- One row per bullet round. Whoever opens a round (bullet_accept for the
-- first, bullet_open_round for the rest) picks its problem and writes the row
-- in the same transaction, so both players always see the same problem at the
-- same moment. `points` is the problem's rating at open, stored once: it is
-- what the round is worth, and the score strip renders exactly this number.
create table if not exists duel_rounds (
  duel_id       bigint not null references duels(id) on delete cascade,
  round_no      int not null check (round_no >= 1),
  problem_id    bigint not null references problem_catalog(id),
  target_rating int not null,
  points        int not null,
  opened_at     timestamptz not null default now(),
  winner_id     bigint references users(id) on delete set null,
  won_at        timestamptz,            -- the judge's clock on the winning AC
  closed_at     timestamptz,            -- null = the round in play
  primary key (duel_id, round_no)
);
-- At most one round in play per duel: the settle/open cycle is idempotent by
-- construction, and a double run cannot open two.
create unique index if not exists duel_rounds_open
  on duel_rounds (duel_id) where closed_at is null;

-- --- battles ----------------------------------------------------------------
create table if not exists battles (
  id               bigserial primary key,
  guild_id         bigint not null references guilds(id) on delete cascade,
  host_id          bigint references users(id) on delete set null,
  name             text not null,
  -- scheduled → active (at starts_at) → closing (at ends_at: no new matches,
  -- the ones running finish on their own clocks) → finished. Cancelled only
  -- by the host, only before the start.
  status           text not null default 'scheduled' check (status in
                     ('scheduled', 'active', 'closing', 'finished', 'cancelled')),
  max_players      int not null check (max_players between 2 and 64),
  -- Tier t plays at tier_base + (t−1)·tier_step.
  tier_base        int not null check (tier_base between 800 and 3000),
  tier_step        int not null default 200 check (tier_step in (100, 200, 300)),
  match_duration_s int not null default 1800,
  duration_s       int not null check (duration_s between 1800 and 28800),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,   -- starts_at + duration_s, set on insert
  -- Set when it finishes: the last player standing, or the top of the ladder
  -- when the clock ends it.
  champion_id      bigint references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
create index if not exists battles_guild_recent on battles (guild_id, created_at desc);
-- The worker's "when do I next need to wake" lookup.
create index if not exists battles_live
  on battles (starts_at, ends_at) where status in ('scheduled', 'active', 'closing');

-- Declared before battle_players so current_match_id can reference it inline.
create table if not exists battle_matches (
  id                   bigserial primary key,
  battle_id            bigint not null references battles(id) on delete cascade,
  tier                 int not null,
  target_rating        int not null,
  a_id                 bigint not null references users(id) on delete cascade,
  b_id                 bigint not null references users(id) on delete cascade,
  problem_id           bigint not null references problem_catalog(id),
  status               text not null default 'active' check (status in ('active', 'finished')),
  -- 'solve' (first AC; the winner climbs), 'forfeit' (conceded; the other
  -- side climbs), 'timeout' (a tie — both stay, winner_id null).
  finish_reason        text check (finish_reason in ('solve', 'forfeit', 'timeout')),
  winner_id            bigint references users(id) on delete set null,
  started_at           timestamptz not null default now(),
  deadline_at          timestamptz not null,
  finished_at          timestamptz,
  winning_submitted_at timestamptz,
  check (a_id <> b_id)
);
create index if not exists battle_matches_battle on battle_matches (battle_id, started_at desc);
-- Belt-and-braces for "one active match per player"; the real guard is the
-- state-checked update in the matchmaker (worker/arena.py).
create unique index if not exists battle_matches_open_a
  on battle_matches (a_id) where status = 'active';
create unique index if not exists battle_matches_open_b
  on battle_matches (b_id) where status = 'active';

create table if not exists battle_players (
  battle_id        bigint not null references battles(id) on delete cascade,
  user_id          bigint not null references users(id) on delete cascade,
  tier             int not null default 1 check (tier >= 1),   -- never goes down
  wins             int not null default 0,
  losses           int not null default 0,
  draws            int not null default 0,
  -- idle: between matches. queued: waiting for someone in the same tier.
  -- matched: in a match. eliminated: alone at the bottom tier — spectating.
  state            text not null default 'idle' check (state in
                     ('idle', 'queued', 'matched', 'eliminated')),
  queued_at        timestamptz,
  current_match_id bigint references battle_matches(id) on delete set null,
  -- The matchmaker found no unseen problem for this pair; shown as the reason
  -- someone is still queued. Cleared on re-queue and on settle.
  pick_failed_at   timestamptz,
  eliminated_at    timestamptz,
  joined_at        timestamptz not null default now(),
  primary key (battle_id, user_id),
  check ((state = 'matched') = (current_match_id is not null)),
  check (state <> 'queued' or queued_at is not null),
  check ((state = 'eliminated') = (eliminated_at is not null))
);

-- --- the problem picker, shared by every mode -------------------------------
-- A rated CF problem near `target`, untouched by every player in `player_ids`
-- (any submission counts as seen — half-solving a problem last month is
-- exactly the head start a race can't have), not in `exclude_ids`, widening
-- the band until something matches. Null only when the catalog is exhausted.
create or replace function arena_pick_problem(
  player_ids bigint[], target int, exclude_ids bigint[] default '{}'
) returns bigint language plpgsql as $$
declare
  band int;
  pick bigint;
begin
  foreach band in array array[150, 300, 600, 3500] loop
    select p.id into pick
      from problem_catalog p
     where p.source = 'cf' and p.active and p.contest_id is not null
       and p.rating between target - band and target + band
       and not (p.id = any (coalesce(exclude_ids, '{}')))
       and not exists (select 1 from submissions s
                        where s.problem_id = p.id and s.user_id = any (player_ids))
     order by random() limit 1;
    if pick is not null then
      return pick;
    end if;
  end loop;
  return null;
end $$;

-- --- bullet -----------------------------------------------------------------
-- Accept a bullet challenge: pick round one, start the clock, open the round —
-- one transaction, so the loser of a two-clicks race sees a started duel and
-- no duel is ever active with nothing to solve. Returns null when there is no
-- such pending challenge for this opponent, 0 when no unseen problem exists at
-- the chosen start (nothing changed; the challenge stays pending), 1 on start.
create or replace function bullet_accept(did bigint, uid bigint) returns int
language plpgsql as $$
declare
  d   duels%rowtype;
  pid bigint;
  pts int;
begin
  select * into d from duels
   where id = did and status = 'pending' and mode = 'bullet' and opponent_id = uid
     and expires_at > now()
   for update;
  if not found then
    return null;
  end if;
  pid := arena_pick_problem(array[d.challenger_id, d.opponent_id], d.bullet_start_rating, '{}');
  if pid is null then
    return 0;
  end if;
  select coalesce(rating, d.bullet_start_rating) into pts from problem_catalog where id = pid;
  update duels set status = 'active', started_at = now(),
         deadline_at = now() + make_interval(secs => duration_s)
   where id = did;
  insert into duel_rounds (duel_id, round_no, problem_id, target_rating, points)
  values (did, 1, pid, d.bullet_start_rating, pts);
  return 1;
end $$;

-- Open the next round of an active bullet duel that has none in play.
-- Returns the new round number; 0 when the catalog has nothing left for this
-- pair (the caller ends the duel on points); null when there is nothing to do
-- (not an active bullet duel, or a round is already open).
create or replace function bullet_open_round(did bigint) returns int
language plpgsql as $$
declare
  d   duels%rowtype;
  n   int;
  tgt int;
  pid bigint;
  pts int;
begin
  select * into d from duels
   where id = did and status = 'active' and mode = 'bullet'
   for update;
  if not found then
    return null;
  end if;
  if exists (select 1 from duel_rounds where duel_id = did and closed_at is null) then
    return null;
  end if;
  select coalesce(max(round_no), 0) + 1 into n from duel_rounds where duel_id = did;
  tgt := least(3500, d.bullet_start_rating + d.bullet_step * (n - 1));
  pid := arena_pick_problem(
    array[d.challenger_id, d.opponent_id], tgt,
    coalesce((select array_agg(problem_id) from duel_rounds where duel_id = did), '{}'));
  if pid is null then
    return 0;
  end if;
  select coalesce(rating, tgt) into pts from problem_catalog where id = pid;
  insert into duel_rounds (duel_id, round_no, problem_id, target_rating, points)
  values (did, n, pid, tgt, pts);
  return n;
end $$;

-- The bell: the higher points total wins, equal is a draw. Also used when the
-- catalog runs dry mid-duel. finish_reason stays 'timeout' — the UI reads the
-- meaning through mode — so the duels check constraint needs no change.
create or replace function bullet_finish(did bigint) returns void
language plpgsql as $$
begin
  update duels d
     set status = 'finished', finish_reason = 'timeout', finished_at = now(),
         winner_id = case when s.cp > s.op then d.challenger_id
                          when s.op > s.cp then d.opponent_id end
    from (select d2.id,
                 coalesce(sum(r.points) filter (where r.winner_id = d2.challenger_id), 0) as cp,
                 coalesce(sum(r.points) filter (where r.winner_id = d2.opponent_id), 0) as op
            from duels d2
            left join duel_rounds r on r.duel_id = d2.id
           where d2.id = did
           group by d2.id) s
   where d.id = s.id and d.status = 'active' and d.mode = 'bullet';
  if found then
    -- The round in play closes unwon.
    update duel_rounds set closed_at = now() where duel_id = did and closed_at is null;
  end if;
end $$;

-- --- battles ----------------------------------------------------------------
-- The knockout rule. Among the players still in, whoever is alone at the
-- lowest tier can never be paired again — nobody below to climb up to them —
-- so they are out. Looped, because removing them can leave the next tier's
-- loner in the same position. That loner is always someone who LOST their
-- way there, never the winner who just climbed: occupied tiers are always
-- contiguous from the bottom (a tier only empties when its last player is
-- eliminated, which needs everything below it empty already — the last
-- player at a tier can't leave by climbing, since a climb leaves its loser
-- behind), so a fresh winner either finds the loser of an earlier match
-- waiting at the new tier or is the last player standing. A matched player
-- always has a same-tier opponent, so the state guard is only defensive.
-- One player left ends it.
create or replace function battle_eliminate(bid bigint) returns void
language plpgsql as $$
declare
  b         battles%rowtype;
  remaining int;
  bottom    int;
  at_bottom int;
  loner     bigint;
begin
  select * into b from battles where id = bid for update;
  if not found or b.status not in ('active', 'closing') then
    return;
  end if;
  loop
    select count(*), min(tier) into remaining, bottom
      from battle_players where battle_id = bid and state <> 'eliminated';
    exit when remaining <= 1;
    select count(*), min(user_id) into at_bottom, loner
      from battle_players
     where battle_id = bid and state <> 'eliminated' and tier = bottom
       and state in ('idle', 'queued');
    exit when at_bottom <> 1
      or (select count(*) from battle_players
           where battle_id = bid and state <> 'eliminated' and tier = bottom) <> 1;
    update battle_players
       set state = 'eliminated', eliminated_at = now(), queued_at = null,
           pick_failed_at = null
     where battle_id = bid and user_id = loner;
  end loop;
  if remaining <= 1 then
    update battles
       set status = 'finished', finished_at = now(),
           champion_id = (select user_id from battle_players
                           where battle_id = bid and state <> 'eliminated' limit 1)
     where id = bid and status in ('active', 'closing');
  end if;
end $$;

-- Finish a match and apply its result. Guarded: only an active match
-- finishes, and only its two current players are touched. winner null = tie
-- (both stay). Returns false when there was nothing to do.
create or replace function battle_settle_match(
  mid bigint, reason text, winner bigint, won_at timestamptz default null
) returns boolean language plpgsql as $$
declare
  m battle_matches%rowtype;
begin
  update battle_matches
     set status = 'finished', finish_reason = reason, winner_id = winner,
         winning_submitted_at = won_at, finished_at = now()
   where id = mid and status = 'active'
   returning * into m;
  if not found then
    return false;
  end if;
  update battle_players p
     set state = 'idle', current_match_id = null, queued_at = null, pick_failed_at = null,
         tier   = p.tier   + case when winner is not null and p.user_id = winner then 1 else 0 end,
         wins   = p.wins   + case when winner is not null and p.user_id = winner then 1 else 0 end,
         losses = p.losses + case when winner is not null and p.user_id <> winner then 1 else 0 end,
         draws  = p.draws  + case when winner is null then 1 else 0 end
   where p.battle_id = m.battle_id and p.user_id in (m.a_id, m.b_id)
     and p.current_match_id = mid;
  perform battle_eliminate(m.battle_id);
  return true;
end $$;

-- --- every clock-driven transition, in one place ----------------------------
-- The app calls arena_sweep(<guild>) before its arena reads and writes; the
-- worker calls arena_sweep(null) each pass. Idempotent, in dependency order,
-- and one round trip instead of ten. A dead worker degrades to "solves
-- detected late", never to a clock that looks alive forever.
create or replace function arena_sweep(gid bigint default null) returns void
language plpgsql as $$
begin
  -- duels
  update duels set status = 'expired'
   where (gid is null or guild_id = gid) and status = 'pending' and expires_at < now();
  update duels set status = 'finished', finish_reason = 'timeout', finished_at = now()
   where (gid is null or guild_id = gid) and status = 'active' and mode = 'classic'
     and deadline_at < now();
  perform bullet_finish(id) from duels
   where (gid is null or guild_id = gid) and status = 'active' and mode = 'bullet'
     and deadline_at < now();

  -- contests
  update guild_contests set status = 'finished', finished_at = now()
   where (gid is null or guild_id = gid) and status = 'active' and ends_at < now();

  -- battles: the start. Fewer than two players is not a tournament.
  update battles b set status = 'cancelled'
   where (gid is null or b.guild_id = gid) and b.status = 'scheduled' and b.starts_at <= now()
     and (select count(*) from battle_players p where p.battle_id = b.id) < 2;
  -- Everyone is queued in join order, so round one pairs by who joined first.
  update battle_players p set state = 'queued', queued_at = p.joined_at
    from battles b
   where b.id = p.battle_id and (gid is null or b.guild_id = gid)
     and b.status = 'scheduled' and b.starts_at <= now() and p.state = 'idle';
  update battles set status = 'active', started_at = now()
   where (gid is null or guild_id = gid) and status = 'scheduled' and starts_at <= now();

  -- battles: the bell. No new matches; the ones running finish on their own.
  update battles set status = 'closing'
   where (gid is null or guild_id = gid) and status = 'active' and ends_at <= now();

  -- a match clock ran out: a tie, both stay
  perform battle_settle_match(m.id, 'timeout', null)
     from battle_matches m
     join battles b on b.id = m.battle_id
    where (gid is null or b.guild_id = gid) and m.status = 'active' and m.deadline_at < now();

  -- nobody waits in a queue that will never be paired again
  update battle_players p set state = 'idle', queued_at = null, pick_failed_at = null
    from battles b
   where b.id = p.battle_id and (gid is null or b.guild_id = gid)
     and p.state = 'queued' and b.status <> 'active';

  -- closing with nothing running: done, and the ladder's top is the champion
  update battles b
     set status = 'finished', finished_at = now(),
         champion_id = (select p.user_id from battle_players p
                         where p.battle_id = b.id
                         order by (p.state <> 'eliminated') desc, p.tier desc,
                                  p.wins desc, p.losses asc, p.joined_at asc
                         limit 1)
   where (gid is null or b.guild_id = gid) and b.status = 'closing'
     and not exists (select 1 from battle_matches m
                      where m.battle_id = b.id and m.status = 'active');
end $$;

-- --- real-time --------------------------------------------------------------
-- Same pipe as everything else: writers NOTIFY on 'standings', the
-- guild-scoped stream fans out, clients refetch and diff.

create or replace function notify_battle_change() returns trigger as $$
begin
  perform pg_notify('standings', json_build_object(
    'type', 'battle', 'guild_id', new.guild_id, 'battle_id', new.id,
    'status', new.status
  )::text);
  return new;
end;
$$ language plpgsql;

drop trigger if exists battles_notify on battles;
create trigger battles_notify
  after insert or update on battles
  for each row execute function notify_battle_change();

-- Roster and match rows carry no guild id; look it up. `status` names which
-- sub-object moved.
create or replace function notify_battle_child_change() returns trigger as $$
declare
  bid bigint;
  gid bigint;
begin
  bid := coalesce(new.battle_id, old.battle_id);
  select guild_id into gid from battles where id = bid;
  if gid is not null then
    perform pg_notify('standings', json_build_object(
      'type', 'battle', 'guild_id', gid, 'battle_id', bid,
      'status', case tg_table_name when 'battle_players' then 'players' else 'match' end
    )::text);
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists battle_players_notify on battle_players;
create trigger battle_players_notify
  after insert or update or delete on battle_players
  for each row execute function notify_battle_child_change();

drop trigger if exists battle_matches_notify on battle_matches;
create trigger battle_matches_notify
  after insert or update on battle_matches
  for each row execute function notify_battle_child_change();

-- A round opening or closing rides the existing 'duel' event.
create or replace function notify_duel_round_change() returns trigger as $$
declare
  gid bigint;
begin
  select guild_id into gid from duels where id = new.duel_id;
  if gid is not null then
    perform pg_notify('standings', json_build_object(
      'type', 'duel', 'guild_id', gid, 'duel_id', new.duel_id, 'status', 'round'
    )::text);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists duel_rounds_notify on duel_rounds;
create trigger duel_rounds_notify
  after insert or update on duel_rounds
  for each row execute function notify_duel_round_change();
