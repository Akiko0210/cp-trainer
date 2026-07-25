import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { getOpenSession } from "@/lib/icpc-queries";
import { getCurrentUser } from "@/lib/queries";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  return NextResponse.json(await getOpenSession(user.id));
}

// Start a virtual contest over a set. One open session at a time (enforced by
// a partial unique index, so a double-click can't create two).
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const { setSlug, durationS } = await req.json().catch(() => ({}));
  if (!setSlug) {
    return NextResponse.json({ error: "setSlug required." }, { status: 400 });
  }
  const existing = await getOpenSession(user.id);
  if (existing) {
    return NextResponse.json(
      { error: "A contest is already running.", session: existing },
      { status: 409 },
    );
  }
  const set = await one<{ id: number }>(
    "select id from contest_sets where slug = $1",
    [setSlug],
  );
  if (!set) return NextResponse.json({ error: "Set not found." }, { status: 404 });

  // Abandon any loose single-problem attempt so the contest board is clean.
  await one(
    `update attempts set ended_at = now(), outcome = 'gave_up'
     where user_id = $1 and ended_at is null`,
    [user.id],
  );

  const duration = Math.max(
    300,
    Math.min(6 * 3600, Number(durationS) || 5 * 3600),
  );
  const session = await one(
    `insert into contest_sessions (user_id, set_id, duration_s)
     values ($1, $2, $3) returning id, started_at, duration_s`,
    [user.id, set.id, duration],
  );
  return NextResponse.json(session);
}
