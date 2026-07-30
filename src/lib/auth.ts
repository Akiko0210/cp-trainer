import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { one, q } from "./db";

/*
  GitHub OAuth + server-side sessions.

  Why GitHub and not passwords: this is a club tool, and storing other people's
  password hashes is a liability with no upside when every competitive
  programmer already has a GitHub account. Nothing secret about a member is
  ever stored here — only their GitHub id, login and avatar.

  Sessions are an opaque random token in an HTTP-only cookie, with the row in
  Postgres as the source of truth so a session can be revoked server-side.
*/

const COOKIE = "cpt_session";
const SESSION_DAYS = 30;

export type SessionUser = {
  id: number;
  github_login: string | null;
  display_name: string | null;
  avatar_url: string | null;
  cf_handle: string | null;
  cf_rating: number | null;
  cf_rank: string | null;
  ability_estimate: number | null;
};

export function oauthConfigured(): boolean {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export function authorizeUrl(state: string, origin: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID ?? "",
    redirect_uri: `${origin}/api/auth/callback`,
    scope: "read:user user:email",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

/** Exchange the callback code for a GitHub profile. */
export async function exchangeCode(
  code: string,
  origin: string,
): Promise<{ id: number; login: string; name: string | null; avatar_url: string; email: string | null }> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/api/auth/callback`,
    }),
  });
  const token = (await tokenRes.json()) as {
    access_token?: string;
    error_description?: string;
  };
  if (!token.access_token) {
    throw new Error(token.error_description ?? "GitHub declined the sign-in.");
  }
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!userRes.ok) throw new Error("Couldn't read your GitHub profile.");
  return userRes.json();
}

/** Upsert the GitHub identity into `users` and return the row id. */
export async function upsertGithubUser(profile: {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}): Promise<number> {
  // One-time adoption of the pre-auth local account. v1 created a single
  // anonymous user row holding the whole mirrored Codeforces history; without
  // this, the first GitHub sign-in would mint a fresh row and silently orphan
  // thousands of submissions and every mastery estimate.
  const existing = await one<{ id: number }>(
    "select id from users where github_id = $1",
    [profile.id],
  );
  if (!existing) {
    const orphan = await one<{ id: number; n: number }>(
      `select id, (select count(*) from users where github_id is null)::int as n
       from users where github_id is null and cf_handle is not null
       order by id limit 1`,
    );
    if (orphan && orphan.n === 1) {
      await q(
        `update users set github_id = $1, github_login = $2,
           display_name = coalesce(display_name, $3), avatar_url = $4,
           email = coalesce($5, email), last_seen_at = now()
         where id = $6`,
        [profile.id, profile.login, profile.name ?? profile.login,
         profile.avatar_url, profile.email, orphan.id],
      );
      return orphan.id;
    }
  }

  const row = await one<{ id: number }>(
    `insert into users (github_id, github_login, display_name, avatar_url, email, last_seen_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (github_id) do update set
       github_login = excluded.github_login,
       display_name = coalesce(users.display_name, excluded.display_name),
       avatar_url = excluded.avatar_url,
       email = coalesce(excluded.email, users.email),
       last_seen_at = now()
     returning id`,
    [profile.id, profile.login, profile.name ?? profile.login, profile.avatar_url, profile.email],
  );
  return row!.id;
}

export async function createSession(userId: number, userAgent?: string) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await q(
    `insert into sessions (token, user_id, expires_at, user_agent)
     values ($1, $2, $3, $4)`,
    [token, userId, expires, userAgent ?? null],
  );
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await q("delete from sessions where token = $1", [token]);
  jar.delete(COOKIE);
}

/**
 * The signed-in user, or null. Every page and API route goes through this —
 * it replaces v1's `select * from users limit 1`.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  return one<SessionUser>(
    `select u.id, u.github_login, u.display_name, u.avatar_url, u.cf_handle,
            u.cf_rating, u.cf_rank, u.ability_estimate
     from sessions s join users u on u.id = s.user_id
     where s.token = $1 and s.expires_at > now()`,
    [token],
  );
}

/** Throwing variant for API routes. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Sign in to do that.");
  }
}

export function newInviteCode(): string {
  // Ambiguity-free alphabet: no O/0, I/1, so a code read aloud in a club
  // meeting or written on a whiteboard survives the trip.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
