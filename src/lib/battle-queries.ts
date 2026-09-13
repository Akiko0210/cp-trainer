import { busyElsewhere, sweepArena, type ArenaError } from "./arena-queries";
import { BATTLE_LIMITS } from "./arena-rules";
import { one, q } from "./db";

export { BATTLE_LIMITS, tierRating } from "./arena-rules";

/*
  The battle arena: a scheduled, host-run tournament (db/migrations/006).

  Everyone starts at tier 1. You are paired only with someone in your own
  tier, in queue order; a match is one problem at that tier's rating on a
  30-minute clock; the first AC climbs a tier, the other side stays, a tie
  keeps both. Nobody ever drops — but alone at the bottom tier there is nobody
  who can ever be paired with you, so you are out, and the last player standing
  ends it early.

  Same division of labour as duels: every rule that is pure SQL lives in the
  schema (battle_settle_match, battle_eliminate, arena_sweep) so the worker and
  this module apply it identically; this module owns who may do what, and
  returns errors in the app's voice. The matchmaker itself runs only in the
  worker — one process, one pairing.

  Rating-free, like the rest of the arena.
*/

export type BattleStatus = "scheduled" | "active" | "closing" | "finished" | "cancelled";
export type BattlePlayerState = "idle" | "queued" | "matched" | "eliminated";

export type BattlePlayer = {
  user_id: number;
  display_name: string | null;
  github_login: string | null;
  avatar_url: string | null;
  cf_handle: string | null;
  tier: number;
  wins: number;
  losses: number;
  draws: number;
  state: BattlePlayerState;
  queued_at: string | null;
  current_match_id: number | null;
  /** Set when the matchmaker found no unseen problem for this pair. */
  pick_failed_at: string | null;
  eliminated_at: string | null;
  joined_at: string;
};

export type BattleMatch = {
  id: number;
  tier: number;
  target_rating: number;
  a_id: number;
  b_id: number;
  a_name: string | null;
  b_name: string | null;
  /** Null on an active match unless the viewer is in it — spectators see
      the problem once the match is over. */
  problem_id: number | null;
  problem_title: string | null;
  problem_url: string | null;
  problem_rating: number | null;
  status: "active" | "finished";
  finish_reason: "solve" | "forfeit" | "timeout" | null;
  winner_id: number | null;
  started_at: string;
  deadline_at: string;
  finished_at: string | null;
  winning_submitted_at: string | null;
};

export type Battle = {
  id: number;
  guild_id: number;
  host_id: number | null;
  host_name: string | null;
  name: string;
  status: BattleStatus;
  max_players: number;
  tier_base: number;
  tier_step: number;
  match_duration_s: number;
  duration_s: number;
  starts_at: string;
  ends_at: string;
  champion_id: number | null;
  champion_name: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Ladder order: still in first, then tier, wins, fewest losses; the
      eliminated at the bottom, most recent first. */
  players: BattlePlayer[];
  /** Newest first. */
  matches: BattleMatch[];
};

export async function createBattle(
  guildId: number,
  hostId: number,
  input: {
    name?: string;
    startsAt: string;
    durationS: number;
    maxPlayers: number;
    tierBase: number;
    tierStep: number;
  },
): Promise<Battle | ArenaError> {
  const { players, tierBase, tierSteps, durationS, leadS } = BATTLE_LIMITS;
  const startsMs = Date.parse(input.startsAt);
  if (!Number.isFinite(startsMs)) return { error: "Pick a start time." };
  const lead = (startsMs - Date.now()) / 1000;
  if (lead < leadS.min) {
    return { error: "Start at least a minute from now — people need time to join." };
  }
  if (lead > leadS.max) return { error: "Start within the next two weeks." };
  const dur = Math.floor(input.durationS);
  if (!(dur >= durationS.min && dur <= durationS.max)) {
    return { error: "A battle runs between 30 minutes and 8 hours." };
  }
  const n = Math.floor(input.maxPlayers);
  if (!(n >= players.min && n <= players.max)) {
    return { error: `Between ${players.min} and ${players.max} players.` };
  }
  const base = Math.floor(input.tierBase);
  if (!(base >= tierBase.min && base <= tierBase.max) || base % 100 !== 0) {
    return { error: `Tier 1 plays between ${tierBase.min} and ${tierBase.max}.` };
  }
  const step = Math.floor(input.tierStep);
  if (!tierSteps.includes(step)) {
    return { error: "Tiers climb by 100, 200 or 300." };
  }
  const open = await one(
    `select 1 from battles
     where guild_id = $1 and status in ('scheduled', 'active', 'closing')`,
    [guildId],
  );
  if (open) {
    return { error: "One battle at a time — finish or cancel the open one." };
  }

  const name = input.name?.trim() || `Battle from ${base}`;
  const row = await one<{ id: number }>(
    `insert into battles
       (guild_id, host_id, name, max_players, tier_base, tier_step, duration_s,
        starts_at, ends_at)
     values ($1, $2, $3, $4, $5, $6, $7::int, $8::timestamptz,
             $8::timestamptz + make_interval(secs => $7::int))
     returning id`,
    [guildId, hostId, name.slice(0, 80), n, base, step, dur, new Date(startsMs).toISOString()],
  );
  // The host plays too — a battle you set up and then watch from the outside
  // is a different feature.
  await q("insert into battle_players (battle_id, user_id) values ($1, $2)", [
    row!.id,
    hostId,
  ]);
  return (await battleById(row!.id, hostId))!;
}

async function battleRow(
  battleId: number,
  guildId: number,
): Promise<{ status: BattleStatus; host_id: number | null } | null> {
  return one("select status, host_id from battles where id = $1 and guild_id = $2", [
    battleId,
    guildId,
  ]);
}

export async function joinBattle(
  battleId: number,
  guildId: number,
  userId: number,
): Promise<Battle | ArenaError> {
  const b = await battleRow(battleId, guildId);
  if (!b) return { error: "No such battle in your guild." };
  if (b.status !== "scheduled") {
    return {
      error:
        b.status === "active" || b.status === "closing"
          ? "Joining closed when it started — this one you watch."
          : "That battle is over.",
    };
  }
  const me = await one<{ cf_handle: string | null }>(
    "select cf_handle from users where id = $1",
    [userId],
  );
  if (!me?.cf_handle) {
    return { error: "Link a Codeforces handle first — solves are detected there." };
  }
  // Capacity is checked in the same statement that takes the seat, so two
  // joins racing at the last seat can overshoot by at most one — harmless.
  const row = await one<{ user_id: number }>(
    `insert into battle_players (battle_id, user_id)
     select $1, $2
      where (select count(*) from battle_players where battle_id = $1)
          < (select max_players from battles where id = $1)
     on conflict do nothing
     returning user_id`,
    [battleId, userId],
  );
  if (!row) {
    const already = await one(
      "select 1 from battle_players where battle_id = $1 and user_id = $2",
      [battleId, userId],
    );
    if (!already) return { error: "It's full." };
  }
  return (await battleById(battleId, userId))!;
}

export async function leaveBattle(
  battleId: number,
  guildId: number,
  userId: number,
): Promise<Battle | ArenaError> {
  const b = await battleRow(battleId, guildId);
  if (!b) return { error: "No such battle in your guild." };
  if (b.status !== "scheduled") return { error: "Too late — it already started." };
  if (b.host_id === userId) {
    return { error: "You're hosting this one. Cancel it instead of slipping out." };
  }
  await q("delete from battle_players where battle_id = $1 and user_id = $2", [
    battleId,
    userId,
  ]);
  return (await battleById(battleId, userId))!;
}

export async function cancelBattle(
  battleId: number,
  guildId: number,
  userId: number,
): Promise<Battle | ArenaError> {
  const row = await one<{ id: number }>(
    `update battles set status = 'cancelled'
     where id = $1 and guild_id = $2 and host_id = $3 and status = 'scheduled'
     returning id`,
    [battleId, guildId, userId],
  );
  if (!row) return { error: "Only the host can cancel it, and only before it starts." };
  return (await battleById(battleId, userId))!;
}

/** The host pulls the start forward to now; the clock still runs its full length. */
export async function startBattle(
  battleId: number,
  guildId: number,
  userId: number,
): Promise<Battle | ArenaError> {
  const players = await one<{ n: number }>(
    "select count(*)::int as n from battle_players where battle_id = $1",
    [battleId],
  );
  if ((players?.n ?? 0) < 2) {
    return { error: "Two players at least — a battle of one is a practice session." };
  }
  const row = await one<{ id: number }>(
    `update battles set starts_at = now(), ends_at = now() + make_interval(secs => duration_s)
     where id = $1 and guild_id = $2 and host_id = $3 and status = 'scheduled'
     returning id`,
    [battleId, guildId, userId],
  );
  if (!row) return { error: "Only the host can start it early, and only while it's scheduled." };
  // The sweep is what actually opens it (queues everyone, flips the status);
  // run it now so the caller sees a live battle, not one starting "now".
  await sweepArena(guildId);
  return (await battleById(battleId, userId))!;
}

async function myState(
  battleId: number,
  guildId: number,
  userId: number,
): Promise<{ status: BattleStatus; state: BattlePlayerState | null } | null> {
  return one(
    `select b.status, p.state
     from battles b
     left join battle_players p on p.battle_id = b.id and p.user_id = $3
     where b.id = $1 and b.guild_id = $2`,
    [battleId, guildId, userId],
  );
}

export async function queueBattle(
  battleId: number,
  guildId: number,
  userId: number,
): Promise<Battle | ArenaError> {
  if ((await busyElsewhere(userId)) === "duel") {
    return { error: "Finish your duel first — one race at a time." };
  }
  const row = await one<{ user_id: number }>(
    `update battle_players p
        set state = 'queued', queued_at = now(), pick_failed_at = null
       from battles b
      where b.id = p.battle_id and p.battle_id = $1 and p.user_id = $2
        and b.guild_id = $3 and b.status = 'active' and p.state = 'idle'
      returning p.user_id`,
    [battleId, userId, guildId],
  );
  if (!row) {
    const s = await myState(battleId, guildId, userId);
    if (!s) return { error: "No such battle in your guild." };
    if (s.state === null) return { error: "You're not in this battle." };
    if (s.state === "eliminated") return { error: "You're out of this one — spectating." };
    if (s.state === "matched") return { error: "You're in a match right now." };
    if (s.state === "queued") return { error: "You're already in the queue." };
    if (s.status === "closing") return { error: "The bell's gone — no new matches." };
    if (s.status === "scheduled") return { error: "It hasn't started yet." };
    return { error: "That battle is over." };
  }
  return (await battleById(battleId, userId))!;
}

export async function unqueueBattle(
  battleId: number,
  guildId: number,
  userId: number,
): Promise<Battle | ArenaError> {
  const row = await one<{ user_id: number }>(
    `update battle_players p
        set state = 'idle', queued_at = null, pick_failed_at = null
       from battles b
      where b.id = p.battle_id and p.battle_id = $1 and p.user_id = $2
        and b.guild_id = $3 and p.state = 'queued'
      returning p.user_id`,
    [battleId, userId, guildId],
  );
  if (!row) return { error: "You're not in the queue." };
  return (await battleById(battleId, userId))!;
}

/** Conceding an active match hands the climb to the other side. */
export async function forfeitMatch(
  battleId: number,
  guildId: number,
  userId: number,
): Promise<Battle | ArenaError> {
  const row = await one<{ ok: boolean }>(
    `select battle_settle_match(
              m.id, 'forfeit', case when m.a_id = $2 then m.b_id else m.a_id end) as ok
       from battle_matches m
       join battles b on b.id = m.battle_id
      where m.battle_id = $1 and b.guild_id = $3 and m.status = 'active'
        and $2 in (m.a_id, m.b_id)`,
    [battleId, userId, guildId],
  );
  if (!row) return { error: "No match of yours to concede." };
  return (await battleById(battleId, userId))!;
}

/** The open battle (scheduled, live or closing) plus recent finished ones. */
export async function getBattles(
  guildId: number,
  viewerId: number,
): Promise<{ open: Battle | null; recent: Battle[] }> {
  const rows = await q<{ id: number; status: BattleStatus }>(
    `select id, status from battles
     where guild_id = $1 and status <> 'cancelled'
     order by created_at desc limit 6`,
    [guildId],
  );
  const open = rows.find((r) => r.status !== "finished");
  const recentIds = rows.filter((r) => r.status === "finished").slice(0, 5).map((r) => r.id);
  return {
    open: open ? await battleById(open.id, viewerId) : null,
    recent: (await Promise.all(recentIds.map((id) => battleById(id, viewerId)))).filter(
      (b): b is Battle => b !== null,
    ),
  };
}

export async function battleById(
  id: number,
  viewerId: number,
): Promise<Battle | null> {
  const battle = await one<Omit<Battle, "players" | "matches">>(
    `select b.*,
            coalesce(h.display_name, h.github_login) as host_name,
            coalesce(c.display_name, c.github_login) as champion_name
       from battles b
       left join users h on h.id = b.host_id
       left join users c on c.id = b.champion_id
      where b.id = $1`,
    [id],
  );
  if (!battle) return null;

  const [players, matches] = await Promise.all([
    q<BattlePlayer>(
      `select p.user_id, u.display_name, u.github_login, u.avatar_url, u.cf_handle,
              p.tier, p.wins, p.losses, p.draws, p.state, p.queued_at,
              p.current_match_id, p.pick_failed_at, p.eliminated_at, p.joined_at
         from battle_players p
         join users u on u.id = p.user_id
        where p.battle_id = $1
        order by (p.state <> 'eliminated') desc, p.tier desc, p.wins desc,
                 p.losses asc, p.eliminated_at desc nulls first, p.joined_at asc`,
      [id],
    ),
    // The problem is the match's secret while it runs: only its two players
    // see it. Everyone sees it afterwards — the record is the point.
    q<BattleMatch>(
      `select m.id, m.tier, m.target_rating, m.a_id, m.b_id,
              coalesce(ua.display_name, ua.github_login) as a_name,
              coalesce(ub.display_name, ub.github_login) as b_name,
              case when m.status = 'finished' or $2 in (m.a_id, m.b_id)
                   then m.problem_id end as problem_id,
              case when m.status = 'finished' or $2 in (m.a_id, m.b_id)
                   then p.title end as problem_title,
              case when m.status = 'finished' or $2 in (m.a_id, m.b_id)
                   then p.url end as problem_url,
              case when m.status = 'finished' or $2 in (m.a_id, m.b_id)
                   then p.rating end as problem_rating,
              m.status, m.finish_reason, m.winner_id, m.started_at, m.deadline_at,
              m.finished_at, m.winning_submitted_at
         from battle_matches m
         join users ua on ua.id = m.a_id
         join users ub on ub.id = m.b_id
         join problem_catalog p on p.id = m.problem_id
        where m.battle_id = $1
        order by m.started_at desc, m.id desc`,
      [id, viewerId],
    ),
  ]);

  return { ...battle, players, matches };
}
