import { NextResponse } from "next/server";
import {
  createDuel,
  getMyDuel,
  getRecentDuels,
  sweepArena,
} from "@/lib/arena-queries";
import { getSessionUser } from "@/lib/auth";
import { workerConfigured } from "@/lib/env";
import { q } from "@/lib/db";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/*
  GET  -> the viewer's duel state: their open (or just-finished) duel, the
          guild's recent results, and who they could challenge.
  POST { opponent_id } -> send a challenge. It stays 'pending' until accepted,
          declined, withdrawn, or expired (DUEL_INVITE_TTL_S).

  No guild in the path, same as every guild route: you're in exactly one.
*/
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const guild = await getMyGuild(user.id);
  if (!guild) {
    return NextResponse.json({ error: "You're not in a guild." }, { status: 404 });
  }

  await sweepArena(guild.id);
  const [duel, recent, members] = await Promise.all([
    getMyDuel(guild.id, user.id),
    getRecentDuels(guild.id),
    // Challengeable = in the guild, linked, and not the viewer. Whether
    // they're already busy duelling is checked at create time, where it's
    // authoritative rather than a stale hint.
    q<{
      user_id: number;
      display_name: string | null;
      github_login: string | null;
      avatar_url: string | null;
      cf_handle: string;
      cf_rating: number | null;
    }>(
      `select id as user_id, display_name, github_login, avatar_url,
              cf_handle, cf_rating
       from users where guild_id = $1 and id <> $2 and cf_handle is not null
       order by coalesce(display_name, github_login)`,
      [guild.id, user.id],
    ),
  ]);

  return NextResponse.json(
    { duel, recent, members, detectable: workerConfigured() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!user.cf_handle) {
    return NextResponse.json(
      { error: "Link a Codeforces handle first — solves are detected there." },
      { status: 409 },
    );
  }
  const guild = await getMyGuild(user.id);
  if (!guild) {
    return NextResponse.json({ error: "You're not in a guild." }, { status: 404 });
  }
  if (!workerConfigured()) {
    // Without the worker nothing watches Codeforces between full syncs, and a
    // race nobody can win isn't worth offering.
    return NextResponse.json(
      { error: "Duels need the sync worker running." },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const opponentId = Number(body.opponent_id);
  if (!Number.isInteger(opponentId)) {
    return NextResponse.json({ error: "Pick an opponent." }, { status: 400 });
  }

  await sweepArena(guild.id);
  const result = await createDuel(guild.id, user.id, opponentId);
  if ("error" in result) return NextResponse.json(result, { status: 409 });
  return NextResponse.json(result);
}
