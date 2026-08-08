import { one, q } from "./db";

/*
  The arena: duels and custom guild contests.

  Division of labour, matching the rest of the app: this module owns every
  decision that is pure SQL — who may challenge whom, which problem a duel or
  contest gets, what the standings are — and the worker owns the only part
  that needs judge traffic: noticing the solve (worker/arena.py). Picking a
  random problem never touches Codeforces, because problem_catalog *is* the
  problemset, mirrored.

  No rating anywhere. A duel is a race between two people who agreed to race;
  nothing here writes to topic_mastery, ability_estimate, or anything else the
  estimator owns.
*/

/** How long a challenge waits for an answer. */
export const DUEL_INVITE_TTL_S = 5 * 60;
/** How long an accepted duel may run before it's a draw. */
export const DUEL_DURATION_S = 45 * 60;

export type DuelStatus =
  | "pending"
  | "declined"
  | "cancelled"
  | "expired"
  | "active"
  | "finished";

export type Duel = {
  id: number;
  guild_id: number;
  challenger_id: number;
  opponent_id: number;
  status: DuelStatus;
  finish_reason: "solve" | "forfeit" | "timeout" | null;
  winner_id: number | null;
  created_at: string;
  expires_at: string;
  started_at: string | null;
  deadline_at: string | null;
  finished_at: string | null;
  winning_submitted_at: string | null;
  // joined display fields
  challenger_name: string | null;
  opponent_name: string | null;
  winner_name: string | null;
  problem_title: string | null;
  problem_url: string | null;
  problem_rating: number | null;
};

export type ArenaError = { error: string };

const DUEL_SELECT = `
  select d.*,
         coalesce(uc.display_name, uc.github_login) as challenger_name,
         coalesce(uo.display_name, uo.github_login) as opponent_name,
         coalesce(uw.display_name, uw.github_login) as winner_name,
         p.title as problem_title, p.url as problem_url, p.rating as problem_rating
  from duels d
  join users uc on uc.id = d.challenger_id
  join users uo on uo.id = d.opponent_id
  left join users uw on uw.id = d.winner_id
  left join problem_catalog p on p.id = d.problem_id`;

/*
  Time-based transitions, run lazily before reads and writes. The worker's
  arena loop runs the same sweeps while it polls; doing them here too means a
  dead worker degrades to "solves detected late", never to a pending
  invitation that looks alive forever. Idempotent by construction.
*/
export async function sweepArena(guildId: number): Promise<void> {
  await q(
    `update duels set status = 'expired'
     where guild_id = $1 and status = 'pending' and expires_at < now()`,
    [guildId],
  );
  await q(
    `update duels set status = 'finished', finish_reason = 'timeout',
                      finished_at = now()
     where guild_id = $1 and status = 'active' and deadline_at < now()`,
    [guildId],
  );
  await q(
    `update guild_contests set status = 'finished', finished_at = now()
     where guild_id = $1 and status = 'active' and ends_at < now()`,
    [guildId],
  );
}

/**
 * The viewer's one relevant duel: open (pending or active), or finished in
 * the last few minutes so the result is still on screen when the race ends.
 * "One open duel per person" is enforced at creation, so this is at most one
 * open row.
 */
export async function getMyDuel(
  guildId: number,
  userId: number,
): Promise<Duel | null> {
  return one<Duel>(
    `${DUEL_SELECT}
     where d.guild_id = $1 and $2 in (d.challenger_id, d.opponent_id)
       and (d.status in ('pending', 'active')
            or (d.status = 'finished' and d.finished_at > now() - interval '10 minutes'))
     order by d.created_at desc limit 1`,
    [guildId, userId],
  );
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

export async function createDuel(
  guildId: number,
  challengerId: number,
  opponentId: number,
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
  const mine = await openDuelFor(challengerId);
  if (mine) return { error: "You already have a duel open. One at a time." };
  const theirs = await openDuelFor(opponentId);
  if (theirs) return { error: "They're already in a duel. Wait it out." };

  const row = await one<{ id: number }>(
    `insert into duels (guild_id, challenger_id, opponent_id, expires_at)
     values ($1, $2, $3, now() + make_interval(secs => $4))
     returning id`,
    [guildId, challengerId, opponentId, DUEL_INVITE_TTL_S],
  );
  return (await duelById(row!.id))!;
}

async function duelById(id: number): Promise<Duel | null> {
  return one<Duel>(`${DUEL_SELECT} where d.id = $1`, [id]);
}

/**
 * Pick the duel problem: rated, from the CF catalog, and untouched by either
 * player — any submission counts as "seen", because half-solving a problem
 * last month is exactly the head start a race can't have. Centred on the
 * players' average rating and widened until something matches, so two
 * grandmasters in a thin band still get a problem rather than an error.
 */
async function pickDuelProblem(
  aId: number,
  bId: number,
): Promise<{ id: number } | null> {
  const avg = await one<{ target: number }>(
    `select coalesce(avg(coalesce(cf_rating, 1200)), 1200)::int as target
     from users where id in ($1, $2)`,
    [aId, bId],
  );
  const target = Math.min(Math.max(avg?.target ?? 1200, 800), 3000);
  for (const band of [150, 300, 600, 3500]) {
    const hit = await one<{ id: number }>(
      `select p.id from problem_catalog p
       where p.source = 'cf' and p.active and p.contest_id is not null
         and p.rating between $1 and $2
         and not exists (select 1 from submissions s
                         where s.problem_id = p.id and s.user_id in ($3, $4))
       order by random() limit 1`,
      [target - band, target + band, aId, bId],
    );
    if (hit) return hit;
  }
  return null;
}

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

  const problem = await pickDuelProblem(duel.challenger_id, duel.opponent_id);
  if (!problem) {
    return { error: "Couldn't find a problem neither of you has touched." };
  }

  // Guarded update: two accept clicks race here, and only one may start the
  // clock. The loser of the race just re-reads the started duel.
  const started = await one<{ id: number }>(
    `update duels set status = 'active', problem_id = $2, started_at = now(),
                      deadline_at = now() + make_interval(secs => $3)
     where id = $1 and status = 'pending'
     returning id`,
    [duelId, problem.id, DUEL_DURATION_S],
  );
  if (!started) return { error: "That challenge is gone." };
  return (await duelById(duelId))!;
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

/** Conceding an active duel hands the win to the other side. */
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
  return (await duelById(duelId))!;
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
