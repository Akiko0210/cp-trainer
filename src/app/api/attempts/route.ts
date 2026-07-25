import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { getCurrentUser, getOpenAttempt } from "@/lib/queries";

// The timer: starting a problem opens an attempt. The user supplies only
// started_at (implicitly: now) — everything else is derived from the judge.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const { problemId } = await req.json().catch(() => ({}));
  if (!problemId) {
    return NextResponse.json({ error: "problemId required." }, { status: 400 });
  }

  // One open attempt at a time: abandon any previous unfinished session.
  await one(
    `update attempts set ended_at = now(), outcome = 'gave_up'
     where user_id = $1 and ended_at is null`,
    [user.id],
  );

  const attempt = await one<{ id: number; started_at: string }>(
    `insert into attempts (user_id, problem_id, started_at)
     values ($1, $2, now()) returning id, started_at`,
    [user.id, problemId],
  );
  return NextResponse.json(attempt);
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  return NextResponse.json(await getOpenAttempt(user.id));
}
