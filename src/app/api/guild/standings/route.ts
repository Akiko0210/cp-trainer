import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  getGuildActivity,
  getMyGuild,
  getStandings,
  type Board,
} from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/*
  Fetched on load and re-fetched when the live stream says something moved.

  There's no guild in the path: you're in exactly one, and it's read from your
  session. That also means a member can't ask for another guild's board by
  editing a URL — the question can't be phrased.
*/
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const guild = await getMyGuild(user.id);
  if (!guild) {
    return NextResponse.json({ error: "You're not in a guild." }, { status: 404 });
  }

  const url = new URL(req.url);
  const board = (url.searchParams.get("board") ?? "elo") as Board;
  const category = url.searchParams.get("category") ?? undefined;

  const [standings, activity] = await Promise.all([
    getStandings(guild.id, board, category),
    getGuildActivity(guild.id, 12),
  ]);

  return NextResponse.json(
    { standings, activity, board, category: category ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
