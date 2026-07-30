import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  createGuild,
  getMyGuild,
  joinByCode,
  leaveGuild,
} from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json(await getMyGuild(user.id));
}

// POST { name, tagline } -> found a guild
// POST { code }          -> join one
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  if (typeof body.code === "string" && body.code.trim()) {
    const result = await joinByCode(user.id, body.code);
    // 409 rather than 400 when you're already in one: the request was
    // well-formed, it conflicts with the one-guild rule.
    if ("error" in result) {
      return NextResponse.json(result, {
        status: result.error.startsWith("No guild") ? 404 : 409,
      });
    }
    return NextResponse.json(result);
  }

  if (typeof body.name === "string" && body.name.trim().length >= 2) {
    const result = await createGuild(user.id, body.name, body.tagline);
    if ("error" in result) return NextResponse.json(result, { status: 409 });
    return NextResponse.json(result);
  }

  return NextResponse.json(
    { error: "Name your guild, or enter an invite code." },
    { status: 400 },
  );
}

// Leave. A departing leader hands over first (see leaveGuild).
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  await leaveGuild(user.id);
  return NextResponse.json({ ok: true });
}
