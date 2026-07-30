import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild, getMyStanding } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/*
  Just enough for the guild chip that follows you around the app: which guild,
  where you sit, how many crowns you hold. Deliberately not the whole board —
  this is re-fetched on every live event, from every open page.
*/
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const guild = await getMyGuild(user.id);
  if (!guild) return NextResponse.json({ guild: null, standing: null });

  return NextResponse.json(
    {
      guild: {
        slug: guild.slug,
        name: guild.name,
        member_count: guild.member_count,
      },
      standing: await getMyStanding(guild.id, user.id),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
