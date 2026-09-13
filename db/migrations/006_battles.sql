-- Bullet duels and the battle arena. Idempotent; safe to re-run.
--
-- Two tournament-style modes on top of the arena (005_arena.sql):
--
--   * A BULLET duel is a duel with a clock and a ladder of problems: first AC
--     takes the round and scores the problem's rating in points, the next,
--     harder problem opens immediately, and the higher total at the bell wins.
--   * A BATTLE is a scheduled, host-run tournament: everyone starts at tier 1,
--     a match is one problem at your tier's rating against someone in the same
--     tier, a win climbs a tier, a tie or a loss stays, nobody ever drops.
--     Alone at the bottom tier means nobody can ever be paired with you, so
--     you are out; the last player standing ends it early.
--
-- Everything time-driven lives in one function, arena_sweep(), so the app's
-- lazy per-request sweep and the worker's loop cannot drift apart. The
-- decisions that must be atomic (accept + first round, settle + promote +
-- eliminate) are plpgsql too: sequential statements inside a function see each
-- other, which a data-modifying CTE — one snapshot for the whole statement —
-- does not. Still rating-free: nothing here touches topic_mastery.

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
