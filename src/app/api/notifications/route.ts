import { NextResponse } from "next/server";
import { sweepArena } from "@/lib/arena-queries";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";
import { listInbox, markRead, markSeen } from "@/lib/notification-queries";

export const dynamic = "force-dynamic";

/*
  GET  -> the viewer's latest inbox rows, each with its duel's live status.
  POST { seen?: number[], read?: number[] } -> move the timestamps, batched:
          the provider collects ids for a tick and sends one request.

  The sweep runs first, as it does on the duels route: a challenge whose
  five minutes ran out must read "expired" here, not "pending" until someone
  happens to open the Duels tab.
*/
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const guild = await getMyGuild(user.id);
  if (!guild) {
    return NextResponse.json({ error: "You're not in a guild." }, { status: 404 });
  }
  await sweepArena(guild.id);
  const rows = await listInbox(user.id);
  return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    seen?: unknown;
    read?: unknown;
  };
  const ids = (v: unknown): number[] =>
    Array.isArray(v)
      ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200)
      : [];
  await Promise.all([markSeen(user.id, ids(body.seen)), markRead(user.id, ids(body.read))]);
  return NextResponse.json({ ok: true });
}
