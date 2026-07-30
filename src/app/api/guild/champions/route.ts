import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getChampions, getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/*
  Who holds each area. One request serves every crown badge on the page — the
  dashboard's eight category cards, the category page band, the guild grid —
  because they all read from one client-side store (GuildChampions.tsx) rather
  than fetching individually.
*/
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const guild = await getMyGuild(user.id);
  if (!guild) return NextResponse.json({ champions: [] });

  return NextResponse.json(
    { champions: await getChampions(guild.id, user.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
