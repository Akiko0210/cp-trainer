import { NextResponse } from "next/server";
import { sweepArena } from "@/lib/arena-queries";
import { getSessionUser } from "@/lib/auth";
import { createBattle, getBattles } from "@/lib/battle-queries";
import { workerConfigured } from "@/lib/env";
import { getMyGuild } from "@/lib/guild-queries";
import { workerPost } from "@/lib/worker";

export const dynamic = "force-dynamic";

/*
  GET  -> the guild's open battle (scheduled, live or closing) and recent ones.
  POST { name?, starts_at, duration_s, max_players, tier_base, tier_step }
       -> schedule a battle; the caller hosts it and is joined.

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
  const { open, recent } = await getBattles(guild.id, user.id);
  return NextResponse.json(
    { open, recent, detectable: workerConfigured() },
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
    // The worker is the matchmaker and the referee; without it a battle is a
    // lobby that never opens.
    return NextResponse.json(
      { error: "Battles need the sync worker running." },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  await sweepArena(guild.id);
  const result = await createBattle(guild.id, user.id, {
    name: typeof body.name === "string" ? body.name : undefined,
    startsAt: String(body.starts_at ?? ""),
    durationS: Number(body.duration_s),
    maxPlayers: Number(body.max_players),
    tierBase: Number(body.tier_base),
    tierStep: Number(body.tier_step),
  });
  if ("error" in result) return NextResponse.json(result, { status: 409 });

  // The worker's loop may be dormant waiting on some other start time; tell
  // it there's a new one. Best-effort: its boot poke and its own
  // re-evaluation cover a worker that is briefly away.
  await workerPost("/arena/poke").catch(() => {});
  return NextResponse.json(result);
}
