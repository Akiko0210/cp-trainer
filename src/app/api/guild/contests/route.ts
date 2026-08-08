import { NextResponse } from "next/server";
import { createContest, getContests, sweepArena } from "@/lib/arena-queries";
import { getSessionUser } from "@/lib/auth";
import { workerConfigured } from "@/lib/env";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/*
  GET  -> the guild's open contest (lobby or active, with its live board) and
          recent finished ones.
  POST { problem_count, rating_min, rating_max, duration_s, name? }
       -> open a lobby. Problems are NOT chosen yet — they're picked at start,
          against the final field, so nobody races on a problem they've seen.
*/
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const guild = await getMyGuild(user.id);
  if (!guild) {
    return NextResponse.json({ error: "You're not in a guild." }, { status: 404 });
  }

  await sweepArena(guild.id);
  const contests = await getContests(guild.id);
  return NextResponse.json(
    { ...contests, detectable: workerConfigured() },
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
    return NextResponse.json(
      { error: "Guild contests need the sync worker running." },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  await sweepArena(guild.id);
  const result = await createContest(guild.id, user.id, {
    name: typeof body.name === "string" ? body.name : undefined,
    problemCount: Number(body.problem_count),
    ratingMin: Number(body.rating_min),
    ratingMax: Number(body.rating_max),
    durationS: Number(body.duration_s),
  });
  if ("error" in result) return NextResponse.json(result, { status: 409 });
  return NextResponse.json(result);
}
