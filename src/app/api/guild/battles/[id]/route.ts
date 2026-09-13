import { NextResponse } from "next/server";
import { sweepArena } from "@/lib/arena-queries";
import { getSessionUser } from "@/lib/auth";
import {
  battleById,
  cancelBattle,
  forfeitMatch,
  joinBattle,
  leaveBattle,
  queueBattle,
  startBattle,
  unqueueBattle,
} from "@/lib/battle-queries";
import { workerConfigured } from "@/lib/env";
import { getMyGuild } from "@/lib/guild-queries";
import { workerPost } from "@/lib/worker";

export const dynamic = "force-dynamic";

/*
  GET  -> one battle: roster, ladder, matches (problems hidden on matches the
          viewer isn't in until they end).
  POST { action: "join" | "leave" | "cancel" | "start" | "queue" | "unqueue"
                 | "forfeit" }
  Every action re-checks ownership and status in SQL — the id in the URL
  grants nothing by itself.
*/
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const guild = await getMyGuild(user.id);
  if (!guild) {
    return NextResponse.json({ error: "You're not in a guild." }, { status: 404 });
  }
  const { id } = await params;
  await sweepArena(guild.id);
  const battle = await battleById(Number(id), user.id);
  if (!battle || battle.guild_id !== guild.id) {
    return NextResponse.json({ error: "No such battle in your guild." }, { status: 404 });
  }
  return NextResponse.json(
    { battle, detectable: workerConfigured() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

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
  const battleId = Number(id);
  const body = await req.json().catch(() => ({}));

  await sweepArena(guild.id);
  const result = await (() => {
    switch (body.action) {
      case "join":
        return joinBattle(battleId, guild.id, user.id);
      case "leave":
        return leaveBattle(battleId, guild.id, user.id);
      case "cancel":
        return cancelBattle(battleId, guild.id, user.id);
      case "start":
        return startBattle(battleId, guild.id, user.id);
      case "queue":
        return queueBattle(battleId, guild.id, user.id);
      case "unqueue":
        return unqueueBattle(battleId, guild.id, user.id);
      case "forfeit":
        return forfeitMatch(battleId, guild.id, user.id);
      default:
        return Promise.resolve({ error: "Unknown action." });
    }
  })();

  if ("error" in result) return NextResponse.json(result, { status: 409 });

  // Anything that changes what the worker should be doing next — someone to
  // pair, a start to wait for or forget — wakes it. Best-effort, as always.
  if (["cancel", "start", "queue", "unqueue", "forfeit"].includes(body.action)) {
    await workerPost("/arena/poke").catch(() => {});
  }
  return NextResponse.json(result);
}
