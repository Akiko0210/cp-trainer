import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild, rotateInviteCode } from "@/lib/guild-queries";

// Rotate a leaked code. Leaders and officers only — enforced in the query.
export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const guild = await getMyGuild(user.id);
  if (!guild) {
    return NextResponse.json({ error: "You're not in a guild." }, { status: 404 });
  }

  const code = await rotateInviteCode(guild.id, user.id);
  if (!code) {
    return NextResponse.json(
      { error: "Only leaders and officers can rotate the code." },
      { status: 403 },
    );
  }
  return NextResponse.json({ invite_code: code });
}
