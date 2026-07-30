-- Groups + auth. Idempotent; safe to re-run.
--
-- v1 assumed one user and read `select * from users limit 1` everywhere. A
-- shared club leaderboard needs real identity, so: GitHub OAuth (no passwords
-- stored anywhere, and every competitive programmer already has an account),
-- server-side sessions, and groups with invite codes.
--
-- The schema was already multi-tenant — every user-owned table carries user_id
-- — so nothing here reshapes existing data.

-- --- identity ---------------------------------------------------------------

alter table users add column if not exists github_id     bigint;
alter table users add column if not exists github_login  text;
alter table users add column if not exists avatar_url    text;
alter table users add column if not exists email         text;
alter table users add column if not exists last_seen_at  timestamptz;
-- Plain (not partial) unique index: Postgres already allows many NULLs in a
-- unique index, and a PARTIAL index can't be inferred by
-- `on conflict (github_id)`, which is exactly what the sign-in upsert uses.
create unique index if not exists users_github_id on users (github_id);

-- cf_handle was unique, which is right (two members can't claim one handle)
-- but it must also be nullable: you sign in first, link a handle after.
alter table users alter column cf_handle drop not null;

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

-- --- groups -----------------------------------------------------------------

create table if not exists groups (
  id          bigserial primary key,
  slug        text unique not null,
  name        text not null,
  description text,
  -- Shareable join code. Rotatable by an owner if it leaks.
  invite_code text unique not null,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists group_members (
  group_id  bigint not null references groups(id) on delete cascade,
  user_id   bigint not null references users(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user on group_members (user_id);

-- --- real-time --------------------------------------------------------------
--
-- The leaderboard updates live. Rather than have every client poll, writers
-- NOTIFY on a channel and one SSE route per client LISTENs and forwards. This
-- trigger fires whenever a materialised mastery row changes, which is the
-- moment a member's standing can actually move.

create or replace function notify_standings_change() returns trigger as $$
declare
  payload text;
begin
  payload := json_build_object(
    'type', 'mastery',
    'user_id', new.user_id,
    'topic_id', new.topic_id,
    'score', new.score,
    'estimate', new.rating_estimate
  )::text;
  -- pg_notify (not NOTIFY) so the payload can be built dynamically.
  perform pg_notify('standings', payload);
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
begin
  if new.verdict = 'OK' then
    perform pg_notify('standings', json_build_object(
      'type', 'solve',
      'user_id', new.user_id,
      'problem_id', new.problem_id
    )::text);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists submissions_notify on submissions;
create trigger submissions_notify
  after insert on submissions
  for each row execute function notify_solve();
