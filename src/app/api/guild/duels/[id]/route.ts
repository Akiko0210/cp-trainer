import { NextResponse } from "next/server";
import {
  acceptDuel,
  cancelDuel,
  declineDuel,
  forfeitDuel,
  getMyDuel,
  sweepArena,
} from "@/lib/arena-queries";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";
import { markDuelRead } from "@/lib/notification-queries";
import { workerPost } from "@/lib/worker";

export const dynamic = "force-dynamic";

// POST { action: "accept" | "decline" | "cancel" | "forfeit" | "poke" }
// Every action re-checks ownership and status in SQL — the id in the URL
// grants nothing by itself.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const guild = await getMyGuild(user.id);
  if (!guild) {
    return NextResponse.json({ error: "You're not in a guild." }, { status: 404 });
  }

  const { id } = await params;
  const duelId = Number(id);
  const body = await req.json().catch(() => ({}));

  await sweepArena(guild.id);

  if (body.action === "poke") {
    // "Check for my solve now": a player who just got AC on Codeforces pulls
    // the worker's next look forward rather than waiting out its sleep.
    // Only a participant in a live duel may, and the CF lock meters the
    // cost regardless of how often they click.
    const mine = await getMyDuel(guild.id, user.id);
    if (!mine || mine.id !== duelId || mine.status !== "active") {
      return NextResponse.json({ error: "No live duel to check." }, { status: 409 });
    }
    await workerPost(`/arena/poke?first=${user.id}`).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const result = await (() => {
    switch (body.action) {
      case "accept":
        return acceptDuel(duelId, user.id);
      case "decline":
        return declineDuel(duelId, user.id);
      case "cancel":
        return cancelDuel(duelId, user.id);
      case "forfeit":
        return forfeitDuel(duelId, user.id);
      default:
        return Promise.resolve({ error: "Unknown action." });
    }
  })();

  if ("error" in result) return NextResponse.json(result, { status: 409 });

  if (body.action === "accept" || body.action === "decline") {
    // Answered from the Duels tab or the bell alike: the challenge leaves the
    // badge either way.
    await markDuelRead(user.id, duelId);
  }
  if (result.status === "active") {
    // The race is on — wake the worker's arena loop so solves are noticed in
    // seconds. Best-effort: if the worker is mid-deploy, its boot-time poke
    // picks the duel up when it returns, so failure here is not failure.
    await workerPost("/arena/poke").catch(() => {});
  }
  return NextResponse.json(result);
}
