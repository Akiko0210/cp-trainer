import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { getCurrentUser, getOpenAttempt } from "@/lib/queries";

// The timer: starting a problem opens an attempt. The user supplies only
// started_at (implicitly: now) — everything else is derived from the judge.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const { problemId, inSession } = await req.json().catch(() => ({}));
  if (!problemId) {
    return NextResponse.json({ error: "problemId required." }, { status: 400 });
  }

  // Inside a virtual contest, the attempt is filed against that session so its
  // splits are measured from the contest start.
  const sessionId = inSession
    ? (
        await one<{ id: number }>(
          "select id from contest_sessions where user_id = $1 and ended_at is null",
          [user.id],
        )
      )?.id ?? null
    : null;

  // One problem in progress at a time: park any previous unfinished attempt.
  await one(
    `update attempts set ended_at = now(), outcome = 'gave_up'
     where user_id = $1 and ended_at is null`,
    [user.id],
  );

  const attempt = await one<{ id: number; started_at: string }>(
    `insert into attempts (user_id, problem_id, started_at, session_id)
     values ($1, $2, now(), $3) returning id, started_at`,
    [user.id, problemId, sessionId],
  );
  return NextResponse.json(attempt);
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  return NextResponse.json(await getOpenAttempt(user.id));
}
