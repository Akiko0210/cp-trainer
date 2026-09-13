import {
  BULLET_DURATIONS_S,
  BULLET_START,
  BULLET_STEPS,
  type DuelMode,
} from "./arena-rules";
import { one, q } from "./db";

export {
  BULLET_DURATIONS_S,
  BULLET_START,
  BULLET_STEPS,
  type DuelMode,
} from "./arena-rules";

/*
  The arena: duels (classic and bullet) and custom guild contests.

  Division of labour, matching the rest of the app: this module owns every
  decision that is pure SQL — who may challenge whom, which problem a duel or
  contest gets, what the standings are — and the worker owns the only part
  that needs judge traffic: noticing the solve (worker/arena.py). Picking a
  random problem never touches Codeforces, because problem_catalog *is* the
  problemset, mirrored — and since 006 the picker itself is a SQL function
  (arena_pick_problem), so the app and the worker draw from one rule.

  No rating anywhere. A duel is a race between two people who agreed to race;
  nothing here writes to topic_mastery, ability_estimate, or anything else the
  estimator owns.
*/

/** How long a challenge waits for an answer. */
export const DUEL_INVITE_TTL_S = 5 * 60;
/** How long an accepted classic duel may run before it's a draw. */
export const DUEL_DURATION_S = 45 * 60;

export type DuelStatus =
  | "pending"
  | "declined"
  | "cancelled"
  | "expired"
  | "active"
  | "finished";

export type DuelRound = {
  round_no: number;
  problem_id: number;
  target_rating: number;
  /** What the round was worth — the problem's rating when it opened. */
  points: number;
  opened_at: string;
  winner_id: number | null;
  winner_name: string | null;
  won_at: string | null;
  closed_at: string | null;
  problem_title: string;
  problem_url: string;
  problem_rating: number | null;
};

export type Duel = {
  id: number;
  guild_id: number;
  challenger_id: number;
  opponent_id: number;
  status: DuelStatus;
  /** Bullet's bell is 'timeout' too: winner_id says who had more points. */
  finish_reason: "solve" | "forfeit" | "timeout" | null;
  winner_id: number | null;
  created_at: string;
  expires_at: string;
  started_at: string | null;
  deadline_at: string | null;
  finished_at: string | null;
  winning_submitted_at: string | null;
  mode: DuelMode;
  duration_s: number;
  bullet_start_rating: number | null;
  bullet_step: number | null;
  // joined display fields
  challenger_name: string | null;
  opponent_name: string | null;
  winner_name: string | null;
  problem_title: string | null;
  problem_url: string | null;
  problem_rating: number | null;
  /** Bullet: points so far (sum of the ratings of rounds taken). 0 for classic. */
  challenger_points: number;
  opponent_points: number;
  rounds_opened: number;
  /** Bullet rounds, oldest first — only on the viewer's own duel. */
  rounds?: DuelRound[];
};

export type ArenaError = { error: string };

const DUEL_SELECT = `
  select d.*,
         coalesce(uc.display_name, uc.github_login) as challenger_name,
         coalesce(uo.display_name, uo.github_login) as opponent_name,
         coalesce(uw.display_name, uw.github_login) as winner_name,
         p.title as problem_title, p.url as problem_url, p.rating as problem_rating,
         pts.challenger_points, pts.opponent_points, pts.rounds_opened
  from duels d
  join users uc on uc.id = d.challenger_id
  join users uo on uo.id = d.opponent_id
  left join users uw on uw.id = d.winner_id
  left join problem_catalog p on p.id = d.problem_id
  left join lateral (
    select coalesce(sum(r.points) filter (where r.winner_id = d.challenger_id), 0)::int
             as challenger_points,
           coalesce(sum(r.points) filter (where r.winner_id = d.opponent_id), 0)::int
             as opponent_points,
           count(*)::int as rounds_opened
    from duel_rounds r where r.duel_id = d.id) pts on true`;

const ROUNDS_SELECT = `
  select r.round_no, r.problem_id, r.target_rating, r.points, r.opened_at,
         r.winner_id, coalesce(uw.display_name, uw.github_login) as winner_name,
         r.won_at, r.closed_at,
         p.title as problem_title, p.url as problem_url, p.rating as problem_rating
  from duel_rounds r
  join problem_catalog p on p.id = r.problem_id
  left join users uw on uw.id = r.winner_id
  where r.duel_id = $1
  order by r.round_no`;

/*
  Time-based transitions, run lazily before reads and writes. arena_sweep()
  in the schema is the one implementation — the worker's loop calls the same
  function — so a dead worker degrades to "solves detected late", never to a
  pending invitation that looks alive forever, and the two can't disagree
  about what a clock means. Idempotent by construction.
*/
export async function sweepArena(guildId: number): Promise<void> {
  await q("select arena_sweep($1::bigint)", [guildId]);
}

/**
 * The viewer's one relevant duel: open (pending or active), or finished in
 * the last few minutes so the result is still on screen when the race ends.
 * "One open duel per person" is enforced at creation, so this is at most one
 * open row. A bullet duel comes with its rounds.
 */
export async function getMyDuel(
  guildId: number,
  userId: number,
): Promise<Duel | null> {
  const duel = await one<Duel>(
    `${DUEL_SELECT}
     where d.guild_id = $1 and $2 in (d.challenger_id, d.opponent_id)
       and (d.status in ('pending', 'active')
            or (d.status = 'finished' and d.finished_at > now() - interval '10 minutes'))
     order by d.created_at desc limit 1`,
    [guildId, userId],
  );
  if (duel && duel.mode === "bullet") {
    duel.rounds = await q<DuelRound>(ROUNDS_SELECT, [duel.id]);
  }
  return duel;
}

/** Finished duels across the guild — the results feed. */
export async function getRecentDuels(
  guildId: number,
  limit = 8,
): Promise<Duel[]> {
  return q<Duel>(
    `${DUEL_SELECT}
     where d.guild_id = $1 and d.status = 'finished'
     order by d.finished_at desc limit $2`,
    [guildId, limit],
  );
}

/** Anyone in an open duel (either side) can't be challenged and can't challenge. */
async function openDuelFor(userId: number): Promise<Duel | null> {
  return one<Duel>(
    `${DUEL_SELECT}
     where $1 in (d.challenger_id, d.opponent_id)
       and (d.status = 'active'
            or (d.status = 'pending' and d.expires_at > now()))
     limit 1`,
    [userId],
  );
}

/**
 * Racing is one thing at a time: someone in an open duel can't queue for a
 * battle match, and someone in a battle match can't be duelled. Returns which
 * race has them, or null.
 */
export async function busyElsewhere(
  userId: number,
): Promise<"duel" | "battle" | null> {
  if (await openDuelFor(userId)) return "duel";
  const match = await one(
    "select 1 from battle_players where user_id = $1 and state = 'matched'",
    [userId],
  );
  return match ? "battle" : null;
}

export type DuelOptions = {
  mode: DuelMode;
  /** Bullet only: the clock, one of BULLET_DURATIONS_S. */
  durationS?: number;
  /** Bullet only: where the ladder starts (BULLET_START) and how it climbs. */
  startRating?: number;
  step?: number;
};

export async function createDuel(
  guildId: number,
  challengerId: number,
  opponentId: number,
  opts: DuelOptions = { mode: "classic" },
): Promise<Duel | ArenaError> {
  if (challengerId === opponentId) {
    return { error: "You can't duel yourself. Codeforces exists for that." };
  }
  const opponent = await one<{ cf_handle: string | null }>(
    "select cf_handle from users where id = $1 and guild_id = $2",
    [opponentId, guildId],
  );
  if (!opponent) return { error: "They're not in your guild." };
  if (!opponent.cf_handle) {
    return { error: "They haven't linked a Codeforces handle yet." };
  }

  let durationS = DUEL_DURATION_S;
  let startRating: number | null = null;
  let step: number | null = null;
  if (opts.mode === "bullet") {
    durationS = Math.floor(opts.durationS ?? 0);
    startRating = Math.floor(opts.startRating ?? 0);
    step = Math.floor(opts.step ?? 0);
    if (!(BULLET_DURATIONS_S as readonly number[]).includes(durationS)) {
      return { error: "Pick a bullet clock: 5, 10, 15, 20 or 30 minutes." };
    }
    if (
      startRating < BULLET_START.min ||
      startRating > BULLET_START.max ||
      startRating % 100 !== 0
    ) {
      return { error: `Start the ladder between ${BULLET_START.min} and ${BULLET_START.max}.` };
    }
    if (!(BULLET_STEPS as readonly number[]).includes(step)) {
      return { error: "The ladder climbs by 50, 100 or 200 a round." };
    }
  } else if (opts.mode !== "classic") {
    return { error: "Unknown duel mode." };
  }

  const mine = await busyElsewhere(challengerId);
  if (mine === "duel") return { error: "You already have a duel open. One at a time." };
  if (mine === "battle") return { error: "You're in a battle match — finish that first." };
  const theirs = await busyElsewhere(opponentId);
  if (theirs === "duel") return { error: "They're already in a duel. Wait it out." };
  if (theirs === "battle") return { error: "They're in a battle match right now." };

  const row = await one<{ id: number }>(
    `insert into duels (guild_id, challenger_id, opponent_id, expires_at,
                        mode, duration_s, bullet_start_rating, bullet_step)
     values ($1, $2, $3, now() + make_interval(secs => $4), $5, $6, $7, $8)
     returning id`,
    [
      guildId,
      challengerId,
      opponentId,
      DUEL_INVITE_TTL_S,
      opts.mode,
      durationS,
      startRating,
      step,
    ],
  );
  return (await duelById(row!.id))!;
}

async function duelById(id: number): Promise<Duel | null> {
  return one<Duel>(`${DUEL_SELECT} where d.id = $1`, [id]);
}

/**
 * Accept a challenge. The problem is chosen here, not at challenge time —
 * picking early would let the challenger scout it while the invitation sat
 * unanswered — by arena_pick_problem: rated, from the CF catalog, untouched
 * by either player (any submission counts as "seen", because half-solving a
 * problem last month is exactly the head start a race can't have), centred
 * on the players' average rating for classic or on the chosen start for
 * bullet, and widened until something matches.
 */
export async function acceptDuel(
  duelId: number,
  userId: number,
): Promise<Duel | ArenaError> {
  const duel = await duelById(duelId);
  if (!duel || duel.opponent_id !== userId) {
    return { error: "That challenge isn't yours to accept." };
  }
  if (duel.status !== "pending") return { error: "That challenge is gone." };
  if (new Date(duel.expires_at).getTime() < Date.now()) {
    await q("update duels set status = 'expired' where id = $1 and status = 'pending'", [
      duelId,
    ]);
    return { error: "Too slow — the challenge expired." };
  }
  if ((await busyElsewhere(userId)) === "battle") {
    return { error: "You're in a battle match — finish that first." };
  }

  if (duel.mode === "bullet") {
    // Pick, start the clock and open round one in one transaction (see
    // bullet_accept in the schema): null = gone, 0 = nothing unseen at that
    // start, 1 = started. Two accept clicks race inside the row lock, and the
    // loser just re-reads the started duel.
    const row = await one<{ started: number | null }>(
      "select bullet_accept($1, $2) as started",
      [duelId, userId],
    );
    if (row?.started === 0) {
      return { error: "No problem neither of you has touched near that start — try another." };
    }
    if (row?.started !== 1) return { error: "That challenge is gone." };
    return (await getDuelWithRounds(duelId))!;
  }

  const avg = await one<{ target: number }>(
    `select coalesce(avg(coalesce(cf_rating, 1200)), 1200)::int as target
     from users where id in ($1, $2)`,
    [duel.challenger_id, duel.opponent_id],
  );
  const target = Math.min(Math.max(avg?.target ?? 1200, 800), 3000);
  // Guarded update: two accept clicks race here, and only one may start the
  // clock. The loser of the race just re-reads the started duel. A null pick
  // (catalog exhausted for this pair) leaves it pending.
  const started = await one<{ id: number; picked: number | null }>(
    `with pick as (
       select arena_pick_problem(array[$2, $3]::bigint[], $4, '{}'::bigint[]) as id)
     update duels d
        set status = 'active', problem_id = pick.id, started_at = now(),
            deadline_at = now() + make_interval(secs => d.duration_s)
       from pick
      where d.id = $1 and d.status = 'pending' and pick.id is not null
      returning d.id, pick.id as picked`,
    [duelId, duel.challenger_id, duel.opponent_id, target],
  );
  if (!started) {
    const still = await duelById(duelId);
    if (still?.status === "pending") {
      return { error: "Couldn't find a problem neither of you has touched." };
    }
    return { error: "That challenge is gone." };
  }
  return (await duelById(duelId))!;
}

async function getDuelWithRounds(duelId: number): Promise<Duel | null> {
  const duel = await duelById(duelId);
  if (duel && duel.mode === "bullet") {
    duel.rounds = await q<DuelRound>(ROUNDS_SELECT, [duelId]);
  }
  return duel;
}

export async function declineDuel(
  duelId: number,
  userId: number,
): Promise<Duel | ArenaError> {
  const row = await one<{ id: number }>(
    `update duels set status = 'declined'
     where id = $1 and opponent_id = $2 and status = 'pending'
     returning id`,
    [duelId, userId],
  );
  if (!row) return { error: "That challenge isn't yours to decline." };
  return (await duelById(duelId))!;
}

export async function cancelDuel(
  duelId: number,
  userId: number,
): Promise<Duel | ArenaError> {
  const row = await one<{ id: number }>(
    `update duels set status = 'cancelled'
     where id = $1 and challenger_id = $2 and status = 'pending'
     returning id`,
    [duelId, userId],
  );
  if (!row) return { error: "Only a pending challenge you sent can be withdrawn." };
  return (await duelById(duelId))!;
}

/** Conceding an active duel hands the win to the other side — points or not. */
export async function forfeitDuel(
  duelId: number,
  userId: number,
): Promise<Duel | ArenaError> {
  const row = await one<{ id: number }>(
    `update duels set status = 'finished', finish_reason = 'forfeit',
            winner_id = case when challenger_id = $2 then opponent_id
                             else challenger_id end,
            finished_at = now()
     where id = $1 and $2 in (challenger_id, opponent_id) and status = 'active'
     returning id`,
    [duelId, userId],
  );
  if (!row) return { error: "No active duel of yours to concede." };
  // A bullet round in play closes unwon.
  await q(
    "update duel_rounds set closed_at = now() where duel_id = $1 and closed_at is null",
    [duelId],
  );
  return (await getDuelWithRounds(duelId))!;
}

// ---------- guild contests ----------

export type ContestStatus = "lobby" | "active" | "finished" | "cancelled";

export type ContestPlayer = {
  user_id: number;
  display_name: string | null;
  github_login: string | null;
  avatar_url: string | null;
  cf_handle: string | null;
  /** epoch ms of first OK per problem ordering, null where unsolved */
  solved_at_ms: (number | null)[];
  solved: number;
  /** sum of (first OK − start) seconds over solved problems */
  penalty_s: number;
};

export type ContestProblem = {
  problem_id: number;
  ordering: number;
  title: string;
  url: string;
  rating: number | null;
};

export type GuildContest = {
  id: number;
  guild_id: number;
  created_by: number | null;
  creator_name: string | null;
  name: string;
  status: ContestStatus;
  problem_count: number;
  rating_min: number;
  rating_max: number;
  duration_s: number;
  created_at: string;
  started_at: string | null;
  ends_at: string | null;
  finished_at: string | null;
  problems: ContestProblem[];
  players: ContestPlayer[];
};

const CONTEST_LIMITS = {
  problems: { min: 1, max: 10 },
  rating: { min: 800, max: 3500 },
  duration_s: { min: 10 * 60, max: 5 * 60 * 60 },
};

export async function createContest(
  guildId: number,
  userId: number,
  input: {
    name?: string;
    problemCount: number;
    ratingMin: number;
    ratingMax: number;
    durationS: number;
  },
): Promise<GuildContest | ArenaError> {
  const { problems, rating, duration_s } = CONTEST_LIMITS;
  const n = Math.floor(input.problemCount);
  if (!(n >= problems.min && n <= problems.max)) {
    return { error: `Between ${problems.min} and ${problems.max} problems.` };
  }
  const lo = Math.floor(input.ratingMin);
  const hi = Math.floor(input.ratingMax);
  if (!(lo >= rating.min && hi <= rating.max && lo <= hi)) {
    return { error: `Rating range must sit inside ${rating.min}–${rating.max}.` };
  }
  const dur = Math.floor(input.durationS);
  if (!(dur >= duration_s.min && dur <= duration_s.max)) {
    return { error: "Duration must be between 10 minutes and 5 hours." };
  }
  const open = await one(
    `select 1 from guild_contests
     where guild_id = $1 and status in ('lobby', 'active')`,
    [guildId],
  );
  if (open) {
    return { error: "One contest at a time — finish or cancel the open one." };
  }

  const name = input.name?.trim() || `${lo}–${hi} × ${n}`;
  const row = await one<{ id: number }>(
    `insert into guild_contests
       (guild_id, created_by, name, problem_count, rating_min, rating_max, duration_s)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [guildId, userId, name.slice(0, 80), n, lo, hi, dur],
  );
  // The creator is racing too — a contest you set up and then watch from the
  // outside is a different feature.
  await q(
    "insert into guild_contest_players (contest_id, user_id) values ($1, $2)",
    [row!.id, userId],
  );
  return (await contestById(row!.id))!;
}

export async function joinContest(
  contestId: number,
  guildId: number,
  userId: number,
): Promise<GuildContest | ArenaError> {
  const c = await one<{ status: string }>(
    "select status from guild_contests where id = $1 and guild_id = $2",
    [contestId, guildId],
  );
  if (!c) return { error: "No such contest in your guild." };
  if (c.status !== "lobby") return { error: "That contest already started." };
  const me = await one<{ cf_handle: string | null }>(
    "select cf_handle from users where id = $1",
    [userId],
  );
  if (!me?.cf_handle) {
    return { error: "Link a Codeforces handle first — solves are detected there." };
  }
  await q(
    `insert into guild_contest_players (contest_id, user_id)
     values ($1, $2) on conflict do nothing`,
    [contestId, userId],
  );
  return (await contestById(contestId))!;
}

export async function leaveContest(
  contestId: number,
  guildId: number,
  userId: number,
): Promise<GuildContest | ArenaError> {
  const c = await one<{ status: string; created_by: number | null }>(
    "select status, created_by from guild_contests where id = $1 and guild_id = $2",
    [contestId, guildId],
  );
  if (!c) return { error: "No such contest in your guild." };
  if (c.status !== "lobby") return { error: "Too late — it already started." };
  if (c.created_by === userId) {
    return { error: "You made this one. Cancel it instead of slipping out." };
  }
  await q(
    "delete from guild_contest_players where contest_id = $1 and user_id = $2",
    [contestId, userId],
  );
  return (await contestById(contestId))!;
}

/**
 * Close the lobby and start the clock. Problems are chosen here — random,
 * rated inside the range, and untouched by anyone in the field, so nobody
 * starts a race halfway down the track.
 */
export async function startContest(
  contestId: number,
  guildId: number,
  userId: number,
): Promise<GuildContest | ArenaError> {
  const c = await one<{
    status: string;
    created_by: number | null;
    problem_count: number;
    rating_min: number;
    rating_max: number;
    duration_s: number;
  }>(
    "select * from guild_contests where id = $1 and guild_id = $2",
    [contestId, guildId],
  );
  if (!c) return { error: "No such contest in your guild." };
  if (c.created_by !== userId) return { error: "Only its creator can start it." };
  if (c.status !== "lobby") return { error: "It already started." };

  const picks = await q<{ id: number }>(
    `select p.id from problem_catalog p
     where p.source = 'cf' and p.active and p.contest_id is not null
       and p.rating between $2 and $3
       and not exists (
         select 1 from submissions s
         join guild_contest_players gp
           on gp.user_id = s.user_id and gp.contest_id = $1
         where s.problem_id = p.id)
     order by random() limit $4`,
    [contestId, c.rating_min, c.rating_max, c.problem_count],
  );
  if (picks.length < c.problem_count) {
    return {
      error: `Only ${picks.length} unseen problem${picks.length === 1 ? "" : "s"} in that range — widen it.`,
    };
  }

  // Same two-clicks guard as acceptDuel: only one start wins.
  const started = await one<{ id: number }>(
    `update guild_contests set status = 'active', started_at = now(),
            ends_at = now() + make_interval(secs => duration_s)
     where id = $1 and status = 'lobby' returning id`,
    [contestId],
  );
  if (!started) return { error: "It already started." };

  const values = picks.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(",");
  await q(
    `insert into guild_contest_problems (contest_id, problem_id, ordering)
     values ${values}`,
    [contestId, ...picks.flatMap((p, i) => [p.id, i])],
  );
  return (await contestById(contestId))!;
}

export async function cancelContest(
  contestId: number,
  guildId: number,
  userId: number,
): Promise<GuildContest | ArenaError> {
  const row = await one<{ id: number }>(
    `update guild_contests set status = 'cancelled'
     where id = $1 and guild_id = $2 and created_by = $3 and status = 'lobby'
     returning id`,
    [contestId, guildId, userId],
  );
  if (!row) return { error: "Only its creator can cancel it, and only before it starts." };
  return (await contestById(contestId))!;
}

/** The open contest (lobby or active) plus recent finished ones. */
export async function getContests(
  guildId: number,
): Promise<{ open: GuildContest | null; recent: GuildContest[] }> {
  const rows = await q<{ id: number; status: ContestStatus }>(
    `select id, status from guild_contests
     where guild_id = $1 and status <> 'cancelled'
     order by created_at desc limit 6`,
    [guildId],
  );
  const open = rows.find((r) => r.status === "lobby" || r.status === "active");
  const recentIds = rows.filter((r) => r.status === "finished").map((r) => r.id);
  return {
    open: open ? await contestById(open.id) : null,
    recent: (await Promise.all(recentIds.map((id) => contestById(id)))).filter(
      (c): c is GuildContest => c !== null,
    ),
  };
}

async function contestById(id: number): Promise<GuildContest | null> {
  const contest = await one<Omit<GuildContest, "problems" | "players">>(
    `select c.*, coalesce(u.display_name, u.github_login) as creator_name
     from guild_contests c left join users u on u.id = c.created_by
     where c.id = $1`,
    [id],
  );
  if (!contest) return null;

  const problems = await q<ContestProblem>(
    `select cp.problem_id, cp.ordering, p.title, p.url, p.rating
     from guild_contest_problems cp
     join problem_catalog p on p.id = cp.problem_id
     where cp.contest_id = $1 order by cp.ordering`,
    [id],
  );

  /*
    The board, straight from the mirror: a player's cell is their first OK on
    that problem inside the contest window. Ranked by solves, then by summed
    solve time — no wrong-answer penalty in v1, because a fun contest that
    punishes trying is neither.
  */
  const cells = await q<{
    user_id: number;
    display_name: string | null;
    github_login: string | null;
    avatar_url: string | null;
    cf_handle: string | null;
    ordering: number | null;
    solved_at: string | null;
  }>(
    `select gp.user_id, u.display_name, u.github_login, u.avatar_url, u.cf_handle,
            cp.ordering,
            min(s.submitted_at) filter (where s.verdict = 'OK') as solved_at
     from guild_contest_players gp
     join users u on u.id = gp.user_id
     join guild_contests c on c.id = gp.contest_id
     left join guild_contest_problems cp on cp.contest_id = gp.contest_id
     left join submissions s on s.user_id = gp.user_id
       and s.problem_id = cp.problem_id
       and s.submitted_at >= c.started_at
       and s.submitted_at <= least(coalesce(c.finished_at, c.ends_at), c.ends_at)
     where gp.contest_id = $1
     group by gp.user_id, u.display_name, u.github_login, u.avatar_url,
              u.cf_handle, cp.ordering
     order by gp.user_id, cp.ordering`,
    [id],
  );

  const startMs = contest.started_at ? new Date(contest.started_at).getTime() : null;
  const byUser = new Map<number, ContestPlayer>();
  for (const cell of cells) {
    let player = byUser.get(cell.user_id);
    if (!player) {
      player = {
        user_id: cell.user_id,
        display_name: cell.display_name,
        github_login: cell.github_login,
        avatar_url: cell.avatar_url,
        cf_handle: cell.cf_handle,
        solved_at_ms: problems.map(() => null),
        solved: 0,
        penalty_s: 0,
      };
      byUser.set(cell.user_id, player);
    }
    if (cell.ordering !== null && cell.solved_at !== null && startMs !== null) {
      const at = new Date(cell.solved_at).getTime();
      player.solved_at_ms[cell.ordering] = at;
      player.solved += 1;
      player.penalty_s += Math.max(0, Math.round((at - startMs) / 1000));
    }
  }
  const players = [...byUser.values()].sort(
    (a, b) => b.solved - a.solved || a.penalty_s - b.penalty_s || a.user_id - b.user_id,
  );

  return { ...contest, problems, players };
}
