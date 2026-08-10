import { cache } from "react";
import { newInviteCode } from "./auth";
import { one, q } from "./db";

/*
  Guilds.

  One guild per person. That single constraint is what makes the feature worth
  building: affiliation lives on the user row, so "my guild" is never ambiguous
  and every page can show where you stand without first asking which group you
  meant. Membership is `users.guild_id`; there is no join table.

  The value people are ranked by is the calibrated ability from the Rasch fit
  (users.ability_estimate, and topic_mastery.rating_estimate per area — see
  worker/estimator.py), not a made-up point system. It is comparable to a
  Codeforces rating and can't be farmed by grinding easy problems, because the
  fit prices what you fail as well as what you clear. A guild leaderboard is
  only interesting if the number means something.
*/

export type Guild = {
  id: number;
  slug: string;
  name: string;
  tagline: string | null;
  invite_code: string;
  created_by: number | null;
  member_count: number;
  linked_count: number;
  // the viewer's role, null if they're not in this guild
  my_role: string | null;
};

export type GuildRole = "leader" | "officer" | "member";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/*
  $1 is always the viewer. Every parameter has to appear in the text — a
  placeholder the query never mentions makes Postgres give up on inferring its
  type ("could not determine data type of parameter $1") rather than ignore it.
*/
const guildSelect = (where: string) => `
  select g.*,
         (select count(*) from users m where m.guild_id = g.id)::int as member_count,
         (select count(*) from users m
           where m.guild_id = g.id and m.cf_handle is not null)::int as linked_count,
         (select guild_role from users me where me.id = $1 and me.guild_id = g.id)
           as my_role
  from guilds g where ${where}`;

/**
 * The viewer's guild, or null if they haven't joined one.
 *
 * Memoised per request: the root layout, the guild hub layout and the page
 * inside it all ask, and against a hosted Postgres each repeat is a network
 * round trip for an answer that cannot change mid-render.
 */
export const getMyGuild = cache(
  async (userId: number): Promise<Guild | null> =>
    one<Guild>(
      guildSelect("g.id = (select guild_id from users where id = $1)"),
      [userId],
    ),
);

/** Used by the invite-link page: show what you're about to join. */
export async function getGuildByCode(
  code: string,
  userId: number,
): Promise<Guild | null> {
  return one<Guild>(guildSelect("upper(g.invite_code) = upper($2)"), [
    userId,
    code.trim(),
  ]);
}

export type GuildError = { error: string };

export async function createGuild(
  userId: number,
  name: string,
  tagline?: string,
): Promise<Guild | GuildError> {
  const current = await getMyGuild(userId);
  if (current) {
    // Enforced here as well as in the UI: silently moving someone out of a
    // guild they lead is not something a "Create" button should be able to do.
    return { error: `You're already in ${current.name}. Leave it first.` };
  }
  const base = slugify(name) || "guild";
  // Slugs are user-visible, so keep them readable and only disambiguate on a
  // real collision.
  let slug = base;
  for (let n = 2; await one("select 1 from guilds where slug = $1", [slug]); n++) {
    slug = `${base}-${n}`;
  }
  const created = await one<{ id: number }>(
    `insert into guilds (slug, name, tagline, invite_code, created_by)
     values ($1, $2, $3, $4, $5) returning id`,
    [slug, name.trim(), tagline?.trim() || null, newInviteCode(), userId],
  );
  await q(
    `update users set guild_id = $1, guild_role = 'leader', guild_joined_at = now()
     where id = $2`,
    [created!.id, userId],
  );
  return (await getMyGuild(userId))!;
}

export async function joinByCode(
  userId: number,
  code: string,
): Promise<Guild | GuildError> {
  const current = await getMyGuild(userId);
  if (current) {
    return { error: `You're already in ${current.name}. Leave it first.` };
  }
  const guild = await one<{ id: number }>(
    "select id from guilds where upper(invite_code) = upper($1)",
    [code.trim()],
  );
  if (!guild) {
    return {
      error: "No guild has that code. Check it with whoever invited you.",
    };
  }
  await q(
    `update users set guild_id = $1, guild_role = 'member', guild_joined_at = now()
     where id = $2`,
    [guild.id, userId],
  );
  return (await getMyGuild(userId))!;
}

/**
 * Leave. A departing leader hands the guild to its longest-standing remaining
 * member — otherwise the last person out leaves a guild nobody can administer,
 * with a leaked invite code nobody can rotate.
 */
export async function leaveGuild(userId: number): Promise<void> {
  const me = await one<{ guild_id: number | null; guild_role: string | null }>(
    "select guild_id, guild_role from users where id = $1",
    [userId],
  );
  if (!me?.guild_id) return;

  if (me.guild_role === "leader") {
    const heir = await one<{ id: number }>(
      `select id from users
        where guild_id = $1 and id <> $2
        order by case guild_role when 'officer' then 0 else 1 end,
                 guild_joined_at, id
        limit 1`,
      [me.guild_id, userId],
    );
    if (heir) {
      await q("update users set guild_role = 'leader' where id = $1", [heir.id]);
    }
  }
  await q(
    `update users set guild_id = null, guild_role = null, guild_joined_at = null
     where id = $1`,
    [userId],
  );
}

export async function rotateInviteCode(
  guildId: number,
  userId: number,
): Promise<string | null> {
  const allowed = await one(
    `select 1 from users
      where id = $1 and guild_id = $2 and guild_role in ('leader', 'officer')`,
    [userId, guildId],
  );
  if (!allowed) return null;
  const row = await one<{ invite_code: string }>(
    "update guilds set invite_code = $2 where id = $1 returning invite_code",
    [guildId, newInviteCode()],
  );
  return row?.invite_code ?? null;
}

// ---------- leaderboards ----------

export type Standing = {
  user_id: number;
  display_name: string | null;
  github_login: string | null;
  avatar_url: string | null;
  cf_handle: string | null;
  cf_rating: number | null;
  role: string;
  // the ranked value; its meaning depends on the board
  value: number | null;
  // supporting numbers shown alongside
  solved_30d: number;
  streak: number;
  se: number | null;
  trend: number | null;
  crowns: number;
  linked: boolean;
};

export type Board = "elo" | "streak" | "solved";

/*
  Streak and 30-day volume for every member, defined exactly as the dashboard
  defines them for one person — inlined as CTEs so a board is one round trip.
*/
const ACTIVITY_CTES = `
  recent as (
    select s.user_id,
           count(distinct s.problem_id) filter (
             where s.verdict = 'OK' and s.submitted_at > now() - interval '30 days'
           )::int as solved_30d
    from submissions s group by s.user_id
  ),
  act as (
    select user_id, submitted_at::date as d from submissions
    union select user_id, started_at::date from attempts
  ),
  runs as (
    select user_id, d,
           d - (row_number() over (partition by user_id order by d))::int
               * interval '1 day' as grp
    from (select distinct user_id, d from act) x
  ),
  spans as (
    select user_id, max(d) as end_d, count(*)::int as len
    from runs group by user_id, grp
  ),
  st as (
    select user_id,
           coalesce(max(len) filter (where end_d >= current_date - 1), 0) as current
    from spans group by user_id
  ),
  -- How many category crowns each member currently holds. Shown on every board
  -- because it's the most interesting single fact about a guild member.
  crown as (
    select user_id, count(*)::int as crowns from (
      select tm.user_id,
             row_number() over (
               partition by tm.topic_id order by tm.rating_estimate desc nulls last
             ) as rn
      from topic_mastery tm
      join topics t on t.id = tm.topic_id
      join users u on u.id = tm.user_id
      where t.division = 'Category' and u.guild_id = $1
        and tm.rating_estimate is not null
    ) r where rn = 1 group by user_id
  )`;

/**
 * Guild standings. `board` picks what members are ranked by; `categorySlug`
 * narrows the ability board to one area.
 *
 * Members who haven't linked a Codeforces handle yet still appear (a roster
 * that hides half its people is worse than one with pending rows) but sort
 * last, flagged as unlinked.
 */
export async function getStandings(
  guildId: number,
  board: Board = "elo",
  categorySlug?: string,
): Promise<Standing[]> {
  const value =
    board === "streak"
      ? "st.current"
      : board === "solved"
        ? "recent.solved_30d"
        : categorySlug
          ? "tm.rating_estimate"
          : "u.ability_estimate";

  return q<Standing>(
    `with ${ACTIVITY_CTES}
     select u.id as user_id, u.display_name, u.github_login, u.avatar_url,
            u.cf_handle, u.cf_rating, u.guild_role as role,
            ${value} as value,
            coalesce(recent.solved_30d, 0) as solved_30d,
            coalesce(st.current, 0)::int as streak,
            ${categorySlug ? "tm.estimate_se" : "u.ability_se"} as se,
            ${categorySlug ? "tm.trend" : "null::int"} as trend,
            coalesce(crown.crowns, 0) as crowns,
            (u.cf_handle is not null) as linked
     from users u
     left join recent on recent.user_id = u.id
     left join st on st.user_id = u.id
     left join crown on crown.user_id = u.id
     ${
       categorySlug
         ? `left join topics t on t.slug = $2
            left join topic_mastery tm on tm.topic_id = t.id and tm.user_id = u.id`
         : ""
     }
     where u.guild_id = $1
     order by (u.cf_handle is null), ${value} desc nulls last, u.id`,
    categorySlug ? [guildId, categorySlug] : [guildId],
  );
}

// ---------- champions ----------

export type Champion = {
  category_slug: string;
  rank: number;
  user_id: number;
  display_name: string | null;
  github_login: string | null;
  avatar_url: string | null;
  cf_handle: string | null;
  estimate: number | null;
  score: number | null;
  contenders: number;
};

export type CategoryChampions = {
  category_slug: string;
  /** Best first, at most three. Empty when nobody has an estimate here yet. */
  members: Champion[];
  /** Where the viewer sits in this area — null if they have no estimate yet. */
  you: Champion | null;
};

/**
 * Who is strongest in each area of the guild — the headline question a guild
 * exists to answer. Top three per category, plus how many members have an
 * estimate there at all, so a "champion" of one is labelled honestly.
 *
 * Ranked on the per-topic Rasch estimate rather than the 0–100 heat score: heat
 * decays when you stop practising, and "strongest in Graphs" should not change
 * hands because the holder took a fortnight off.
 */
export async function getChampions(
  guildId: number,
  meId: number,
): Promise<CategoryChampions[]> {
  const rows = await q<Champion>(
    `with ranked as (
       select replace(t.slug, 'cat-', '') as category_slug,
              u.id as user_id, u.display_name, u.github_login, u.avatar_url,
              u.cf_handle,
              tm.rating_estimate as estimate, tm.score,
              row_number() over (
                partition by t.id order by tm.rating_estimate desc nulls last, u.id
              )::int as rank,
              count(*) over (partition by t.id)::int as contenders
       from users u
       join topic_mastery tm on tm.user_id = u.id
       join topics t on t.id = tm.topic_id
       where u.guild_id = $1 and t.division = 'Category'
         and tm.rating_estimate is not null
     )
     -- The viewer's own row comes back even when they're nowhere near the
     -- podium: "Mira holds Graphs, you're 4th of 6" is the useful sentence, and
     -- fetching it separately would let the two halves disagree mid-update.
     select * from ranked where rank <= 3 or user_id = $2
     order by category_slug, rank`,
    [guildId, meId],
  );

  const byCategory = new Map<string, CategoryChampions>();
  for (const row of rows) {
    let entry = byCategory.get(row.category_slug);
    if (!entry) {
      entry = { category_slug: row.category_slug, members: [], you: null };
      byCategory.set(row.category_slug, entry);
    }
    if (row.rank <= 3) entry.members.push(row);
    if (row.user_id === meId) entry.you = row;
  }
  return [...byCategory.values()];
}

export type GuildActivity = {
  user_id: number;
  display_name: string | null;
  avatar_url: string | null;
  title: string | null;
  url: string | null;
  rating: number | null;
  submitted_at: string;
};

/** Recent solves across the guild — the live ticker's backing data. */
export async function getGuildActivity(
  guildId: number,
  limit = 12,
): Promise<GuildActivity[]> {
  return q<GuildActivity>(
    `select u.id as user_id, u.display_name, u.avatar_url,
            p.title, p.url, p.rating, s.submitted_at
     from submissions s
     join users u on u.id = s.user_id
     left join problem_catalog p on p.id = s.problem_id
     where u.guild_id = $1 and s.verdict = 'OK'
     order by s.submitted_at desc
     limit $2`,
    [guildId, limit],
  );
}

/**
 * The viewer's own position, for the nav chip that follows them around the app:
 * overall rank, roster size, and how many crowns they hold.
 */
export type MyStanding = {
  rank: number | null;
  members: number;
  crowns: number;
};

export async function getMyStanding(
  guildId: number,
  userId: number,
): Promise<MyStanding> {
  const row = await one<{
    rank: number | null;
    members: number;
    crowns: number;
  }>(
    `with ranked as (
       select id,
              rank() over (order by ability_estimate desc nulls last)::int as rank
       from users where guild_id = $1
     ),
     crown as (
       select count(*)::int as crowns from (
         select tm.user_id,
                row_number() over (
                  partition by tm.topic_id order by tm.rating_estimate desc nulls last
                ) as rn
         from topic_mastery tm
         join topics t on t.id = tm.topic_id
         join users u on u.id = tm.user_id
         where t.division = 'Category' and u.guild_id = $1
           and tm.rating_estimate is not null
       ) r where rn = 1 and user_id = $2
     )
     select (select rank from ranked where id = $2) as rank,
            (select count(*)::int from ranked) as members,
            (select crowns from crown) as crowns`,
    [guildId, userId],
  );
  return {
    rank: row?.rank ?? null,
    members: row?.members ?? 0,
    crowns: row?.crowns ?? 0,
  };
}
