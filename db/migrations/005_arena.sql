-- The arena: duels and custom guild contests. Idempotent; safe to re-run.
--
-- Both features answer the same question — "who gets it first?" — from the
-- submissions mirror the worker already maintains. Nothing here talks to a
-- judge: problems are picked from problem_catalog (pure SQL), and solves are
-- detected by the worker's arena loop (worker/arena.py), which polls only
-- while a duel or contest is actually live so an idle install still lets a
-- scale-to-zero database sleep.
--
-- Neither carries any rating. A duel is a race, not an assessment: nothing
-- writes to topic_mastery or ability_estimate, and losing one costs nothing
-- but pride.

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
  -- How a finished duel finished: 'solve' (someone got AC), 'forfeit'
  -- (someone conceded; the other wins), 'timeout' (nobody solved it — a draw,
  -- winner_id stays null).
  finish_reason text check (finish_reason in ('solve', 'forfeit', 'timeout')),
  winner_id     bigint references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  -- A pending invitation is only good for a few minutes; the challenger is
  -- sitting there ready, and an invite answered an hour later is a different
  -- mood entirely.
  expires_at    timestamptz not null,
  started_at    timestamptz,
  -- Active duels end even if nobody solves the problem, so the arena loop is
  -- never polling for a race both sides silently walked away from.
  deadline_at   timestamptz,
  finished_at   timestamptz,
  -- The judge's own timestamp of the winning submission — the fact the race
  -- is decided on, kept so the result can always show the margin.
  winning_submitted_at timestamptz
);
create index if not exists duels_guild_recent on duels (guild_id, created_at desc);
-- "One open duel per person" is enforced by the app on create; this partial
-- index keeps that check (and the my-duel lookup) cheap.
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

-- --- real-time --------------------------------------------------------------
-- Same pipe as the leaderboard: writers NOTIFY, the guild-scoped stream fans
-- out, clients refetch. Payloads carry guild_id because that is what the
-- stream filters on.

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

-- A verdict that BECOMES 'OK' must notify, not only a row inserted as 'OK'.
-- The arena loop sees fresh submissions as TESTING first and upserts the OK
-- over them moments later — an UPDATE, which the insert-only trigger above
-- (submissions_notify) never fires for. Narrow WHEN: re-syncs re-upsert
-- every page they read, and touching an already-OK row must not re-announce
-- a solve from last month.
drop trigger if exists submissions_verdict_notify on submissions;
create trigger submissions_verdict_notify
  after update of verdict on submissions
  for each row
  when (old.verdict is distinct from new.verdict and new.verdict = 'OK')
  execute function notify_solve();
