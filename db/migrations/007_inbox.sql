-- The inbox: a per-person record of what happened to their duels.
-- Idempotent; safe to re-run.
--
-- A challenge used to be visible on the Duels tab and nowhere else. This
-- table is what lets the header bell, the top-right popup and the
-- shown-on-login path exist: one row per (recipient, duel, kind), written
-- HERE by a trigger on duels — never by the app — so every transition
-- produces its row whether the app, the worker, arena_sweep() or
-- bullet_finish() made it. Round wins are deliberately not rows: they are
-- transient, and the room already derives them from the duel event.
--
-- Transport rides the existing 'standings' channel. `recipient_id` (not
-- `user_id`: mastery/solve/roster already use that for the actor) marks the
-- event as addressed; both fan-outs drop it for anyone else.

create table if not exists notifications (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,   -- the recipient
  guild_id   bigint not null references guilds(id) on delete cascade,
  kind       text not null check (kind in
               ('duel_challenge', 'duel_accepted', 'duel_declined',
                'duel_expired', 'duel_finished')),
  duel_id    bigint references duels(id) on delete cascade,
  actor_id   bigint references users(id) on delete set null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  seen_at    timestamptz,   -- a tab displayed it (popup or bell list)
  read_at    timestamptz    -- acted on, dismissed, or listed and closed
);
create index if not exists notifications_user_recent
  on notifications (user_id, id desc);
create index if not exists notifications_user_unread
  on notifications (user_id) where read_at is null;
-- One row per (recipient, duel, kind): a transition that fires twice (a
-- double-clicked accept, the sweep running in the app and the worker at
-- once) inserts nothing the second time.
create unique index if not exists notifications_duel_once
  on notifications (user_id, duel_id, kind) where duel_id is not null;

-- Any inbox row, from any future writer, is announced the same way.
create or replace function notify_inbox_row() returns trigger as $$
begin
  perform pg_notify('standings', json_build_object(
    'type', 'inbox', 'guild_id', new.guild_id, 'recipient_id', new.user_id,
    'id', new.id, 'kind', new.kind, 'duel_id', new.duel_id
  )::text);
  return new;
end;
$$ language plpgsql;

drop trigger if exists notifications_notify on notifications;
create trigger notifications_notify
  after insert on notifications
  for each row execute function notify_inbox_row();

-- Which rows a duel produces. Cancelled writes nothing: the opponent's
-- challenge row reads its live status off duels, so "withdrawn" shows up
-- without a second row saying so.
create or replace function duel_inbox() returns trigger as $$
declare
  pts jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      insert into notifications (user_id, guild_id, kind, duel_id, actor_id, payload)
      values (new.opponent_id, new.guild_id, 'duel_challenge', new.id, new.challenger_id,
              jsonb_build_object('mode', new.mode, 'duration_s', new.duration_s,
                                 'bullet_start_rating', new.bullet_start_rating,
                                 'bullet_step', new.bullet_step))
      on conflict do nothing;
    end if;
    return new;
  end if;

  if old.status = 'pending' and new.status = 'active' then
    insert into notifications (user_id, guild_id, kind, duel_id, actor_id, payload)
    values (new.challenger_id, new.guild_id, 'duel_accepted', new.id, new.opponent_id,
            jsonb_build_object('mode', new.mode))
    on conflict do nothing;
  elsif old.status = 'pending' and new.status = 'declined' then
    insert into notifications (user_id, guild_id, kind, duel_id, actor_id, payload)
    values (new.challenger_id, new.guild_id, 'duel_declined', new.id, new.opponent_id,
            jsonb_build_object('mode', new.mode))
    on conflict do nothing;
  elsif old.status = 'pending' and new.status = 'expired' then
    insert into notifications (user_id, guild_id, kind, duel_id, actor_id, payload)
    values (new.challenger_id, new.guild_id, 'duel_expired', new.id, null,
            jsonb_build_object('mode', new.mode))
    on conflict do nothing;
  elsif old.status = 'active' and new.status = 'finished' then
    -- winner_id and finish_reason are set in the same statement as the
    -- status everywhere (forfeit, settle, bullet_finish), so new.* is final.
    if new.mode = 'bullet' then
      select jsonb_build_object(
        'challenger_points',
          coalesce(sum(points) filter (where winner_id = new.challenger_id), 0),
        'opponent_points',
          coalesce(sum(points) filter (where winner_id = new.opponent_id), 0))
      into pts from duel_rounds where duel_id = new.id;
    end if;
    insert into notifications (user_id, guild_id, kind, duel_id, actor_id, payload)
    select u, new.guild_id, 'duel_finished', new.id, new.winner_id,
           jsonb_build_object('mode', new.mode, 'winner_id', new.winner_id,
                              'finish_reason', new.finish_reason) || pts
      from unnest(array[new.challenger_id, new.opponent_id]) as u
    on conflict do nothing;
  end if;
  return new;
end;
$$ language plpgsql;

-- Two triggers, one function: OLD cannot appear in an INSERT trigger's WHEN.
drop trigger if exists duels_inbox_insert on duels;
create trigger duels_inbox_insert
  after insert on duels
  for each row execute function duel_inbox();

drop trigger if exists duels_inbox_update on duels;
create trigger duels_inbox_update
  after update of status on duels
  for each row when (old.status is distinct from new.status)
  execute function duel_inbox();
