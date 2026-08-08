import { NextResponse } from "next/server";
import {
  cancelContest,
  joinContest,
  leaveContest,
  startContest,
  sweepArena,
} from "@/lib/arena-queries";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";
import { workerPost } from "@/lib/worker";

export const dynamic = "force-dynamic";

// POST { action: "join" | "leave" | "start" | "cancel" }
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
  const contestId = Number(id);
  const body = await req.json().catch(() => ({}));

  await sweepArena(guild.id);
  const result = await (() => {
    switch (body.action) {
      case "join":
        return joinContest(contestId, guild.id, user.id);
      case "leave":
        return leaveContest(contestId, guild.id, user.id);
      case "start":
        return startContest(contestId, guild.id, user.id);
      case "cancel":
        return cancelContest(contestId, guild.id, user.id);
      default:
        return Promise.resolve({ error: "Unknown action." });
    }
  })();

  if ("error" in result) return NextResponse.json(result, { status: 409 });

  if (result.status === "active") {
    // Same contract as duels: wake the arena loop, shrug if the worker is
    // briefly away — its boot poke recovers anything already active.
    await workerPost("/arena/poke").catch(() => {});
  }
  return NextResponse.json(result);
}
