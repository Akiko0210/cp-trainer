-- Groups -> guilds. Idempotent; safe to re-run.
--
-- The concept changed: a person belongs to exactly ONE guild, not to any
-- number of groups. That is not a cosmetic rename, it's what makes the guild
-- worth showing everywhere — if affiliation is single-valued it can live on
-- the user row, so every page in the app can answer "where do I stand among
-- my people?" with a join instead of a membership lookup and a choice of which
-- group they meant.
--
-- Consequences, on purpose:
--   * membership moves from a join table to users.guild_id
--   * roles get guild vocabulary (owner -> leader, admin -> officer)
--   * groups / group_members are dropped, after their rows are carried over
--   * pg_notify payloads carry guild_id, so a stream filters by guild rather
--     than by a snapshot of member ids taken when the viewer connected

create table if not exists guilds (
  id          bigserial primary key,
  slug        text unique not null,
  name        text not null,
  tagline     text,
  -- Shareable join code. Rotatable by a leader if it leaks.
  invite_code text unique not null,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table users add column if not exists guild_id        bigint;
alter table users add column if not exists guild_role      text;
alter table users add column if not exists guild_joined_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_guild_id_fkey'
  ) then
    -- Deleting a guild empties it rather than deleting its people.
    alter table users add constraint users_guild_id_fkey
      foreign key (guild_id) references guilds(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'users_guild_role_check'
  ) then
    alter table users add constraint users_guild_role_check
      check (guild_role is null or guild_role in ('leader', 'officer', 'member'));
  end if;
end $$;

-- The one index that matters: every guild query starts "my guild's members".
create index if not exists users_guild on users (guild_id);

-- --- carry over the old groups, if this DB has any -------------------------

do $$
begin
  if to_regclass('public.groups') is null then return; end if;

  insert into guilds (id, slug, name, tagline, invite_code, created_by, created_at)
  select id, slug, name, description, invite_code, created_by, created_at
  from groups
  on conflict (slug) do nothing;
  perform setval('guilds_id_seq', coalesce((select max(id) from guilds), 1));

  -- One guild per person now, so a member of several groups keeps the one they
  -- joined first. Nobody is in two groups today; this is here so the migration
  -- is correct rather than merely sufficient.
  update users u
  set guild_id        = pick.group_id,
      guild_role      = case pick.role
                          when 'owner' then 'leader'
                          when 'admin' then 'officer'
                          else 'member'
                        end,
      guild_joined_at = pick.joined_at
  from (
    select distinct on (user_id) user_id, group_id, role, joined_at
    from group_members
    order by user_id, joined_at, group_id
  ) pick
  where pick.user_id = u.id and u.guild_id is null;

  drop table group_members;
  drop table groups;
end $$;

-- --- real-time --------------------------------------------------------------
--
-- Same shape as before (writers NOTIFY, one LISTEN per Node process fans out to
-- the SSE streams) with one change: the payload names the guild. A viewer's
-- stream can then filter on guild_id, which means someone joining mid-session
-- shows up immediately — under the old member-id filter their events were
-- dropped until the viewer reloaded.
--
-- A user with no guild produces no notifications at all: nobody is watching,
-- and a solo install shouldn't pay for the plumbing.

create or replace function notify_standings_change() returns trigger as $$
declare
  gid bigint;
begin
  select guild_id into gid from users where id = new.user_id;
  if gid is null then return new; end if;
  -- pg_notify (not NOTIFY) so the payload can be built dynamically.
  perform pg_notify('standings', json_build_object(
    'type', 'mastery',
    'guild_id', gid,
    'user_id', new.user_id,
    'topic_id', new.topic_id,
    'score', new.score,
    'estimate', new.rating_estimate
  )::text);
  return new;
end;
$$ language plpgsql;

drop trigger if exists topic_mastery_notify on topic_mastery;
create trigger topic_mastery_notify
  after insert or update on topic_mastery
  for each row execute function notify_standings_change();

-- A solve is worth announcing in the activity feed even before mastery
-- recomputes, so submissions notify too (AC only — noise otherwise).
create or replace function notify_solve() returns trigger as $$
declare
  gid bigint;
begin
  if new.verdict <> 'OK' then return new; end if;
  select guild_id into gid from users where id = new.user_id;
  if gid is null then return new; end if;
  perform pg_notify('standings', json_build_object(
    'type', 'solve',
    'guild_id', gid,
    'user_id', new.user_id,
    'problem_id', new.problem_id
  )::text);
  return new;
end;
$$ language plpgsql;

drop trigger if exists submissions_notify on submissions;
create trigger submissions_notify
  after insert on submissions
  for each row execute function notify_solve();

-- Joining, leaving, and a re-fitted overall ability all move the roster or the
-- Ability board, and both live on `users` rather than on a per-topic row.
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
