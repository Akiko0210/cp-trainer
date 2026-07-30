import { newInviteCode } from "./auth";
import { one, q } from "./db";

/*
  Groups and their standings.

  The "Elo" a member is ranked by is the calibrated ability from the Rasch fit
  (users.ability_estimate — see worker/estimator.py), not a made-up point
  system. That matters for a club: it's comparable to a Codeforces rating, and
  nobody can farm it by grinding easy problems, because the fit accounts for
  what you fail as well as what you clear.

  Per-topic standings use the same estimate scoped to a category, and the
  streak board uses the same streak definition as the dashboard.
*/

export type Group = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  invite_code: string;
  created_by: number | null;
  member_count: number;
  role: string | null;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export async function createGroup(
  userId: number,
  name: string,
  description?: string,
): Promise<Group> {
  const base = slugify(name) || "club";
  // Slugs are user-visible in URLs, so keep them readable and only
  // disambiguate when there's an actual collision.
  let slug = base;
  for (let n = 2; await one("select 1 from groups where slug = $1", [slug]); n++) {
    slug = `${base}-${n}`;
  }
  const group = await one<Group>(
    `insert into groups (slug, name, description, invite_code, created_by)
     values ($1, $2, $3, $4, $5)
     returning *, 1 as member_count, 'owner' as role`,
    [slug, name.trim(), description?.trim() || null, newInviteCode(), userId],
  );
  await q(
    `insert into group_members (group_id, user_id, role) values ($1, $2, 'owner')`,
    [group!.id, userId],
  );
  return group!;
}

export async function joinByCode(
  userId: number,
  code: string,
): Promise<Group | null> {
  const group = await one<{ id: number; slug: string }>(
    "select id, slug from groups where upper(invite_code) = upper($1)",
    [code.trim()],
  );
  if (!group) return null;
  await q(
    `insert into group_members (group_id, user_id, role) values ($1, $2, 'member')
     on conflict (group_id, user_id) do nothing`,
    [group.id, userId],
  );
  return getGroup(group.slug, userId);
}

export async function getGroup(
  slug: string,
  userId: number | null,
): Promise<Group | null> {
  return one<Group>(
    `select g.*,
            (select count(*) from group_members m where m.group_id = g.id)::int
              as member_count,
            (select role from group_members m
              where m.group_id = g.id and m.user_id = $2) as role
     from groups g where g.slug = $1`,
    [slug, userId],
  );
}

export async function getMyGroups(userId: number): Promise<Group[]> {
  return q<Group>(
    `select g.*, gm.role,
            (select count(*) from group_members m where m.group_id = g.id)::int
              as member_count
     from groups g
     join group_members gm on gm.group_id = g.id and gm.user_id = $1
     order by gm.joined_at`,
    [userId],
  );
}

export async function rotateInviteCode(
  groupId: number,
  userId: number,
): Promise<string | null> {
  const allowed = await one(
    `select 1 from group_members where group_id = $1 and user_id = $2
       and role in ('owner', 'admin')`,
    [groupId, userId],
  );
  if (!allowed) return null;
  const row = await one<{ invite_code: string }>(
    "update groups set invite_code = $2 where id = $1 returning invite_code",
    [groupId, newInviteCode()],
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
  // the ranked value; meaning depends on the board
  value: number | null;
  // supporting numbers shown alongside
  solved_30d: number;
  streak: number;
  se: number | null;
  trend: number | null;
  linked: boolean;
};

export type Board = "elo" | "streak" | "solved";

/**
 * Group standings. `board` picks what members are ranked by; `categorySlug`
 * narrows the Elo board to one topic area.
 *
 * Members who haven't linked a Codeforces handle yet still appear (a club
 * roster that hides half its people is worse than one with pending rows) but
 * sort last, flagged as unlinked.
 */
export async function getStandings(
  groupId: number,
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
    `with recent as (
       select s.user_id,
              count(distinct s.problem_id) filter (
                where s.verdict = 'OK'
                  and s.submitted_at > now() - interval '30 days'
              )::int as solved_30d
       from submissions s group by s.user_id
     ),
     -- one streak row per member, same definition as the dashboard
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
     )
     select u.id as user_id, u.display_name, u.github_login, u.avatar_url,
            u.cf_handle, u.cf_rating, gm.role,
            ${value} as value,
            coalesce(recent.solved_30d, 0) as solved_30d,
            coalesce(st.current, 0)::int as streak,
            ${categorySlug ? "tm.estimate_se" : "u.ability_se"} as se,
            ${categorySlug ? "tm.trend" : "null::int"} as trend,
            (u.cf_handle is not null) as linked
     from group_members gm
     join users u on u.id = gm.user_id
     left join recent on recent.user_id = u.id
     left join st on st.user_id = u.id
     ${
       categorySlug
         ? `left join topics t on t.slug = $2
            left join topic_mastery tm on tm.topic_id = t.id and tm.user_id = u.id`
         : ""
     }
     where gm.group_id = $1
     order by (u.cf_handle is null), ${value} desc nulls last, u.id`,
    categorySlug ? [groupId, categorySlug] : [groupId],
  );
}

export type GroupActivity = {
  user_id: number;
  display_name: string | null;
  avatar_url: string | null;
  title: string | null;
  url: string | null;
  rating: number | null;
  submitted_at: string;
};

/** Recent solves across the group — the live ticker's backing data. */
export async function getGroupActivity(
  groupId: number,
  limit = 12,
): Promise<GroupActivity[]> {
  return q<GroupActivity>(
    `select u.id as user_id, u.display_name, u.avatar_url,
            p.title, p.url, p.rating, s.submitted_at
     from submissions s
     join group_members gm on gm.user_id = s.user_id and gm.group_id = $1
     join users u on u.id = s.user_id
     left join problem_catalog p on p.id = s.problem_id
     where s.verdict = 'OK'
     order by s.submitted_at desc
     limit $2`,
    [groupId, limit],
  );
}

/** Member ids in a group — used to filter real-time events server-side. */
export async function getGroupMemberIds(groupId: number): Promise<number[]> {
  const rows = await q<{ user_id: number }>(
    "select user_id from group_members where group_id = $1",
    [groupId],
  );
  return rows.map((r) => r.user_id);
}
