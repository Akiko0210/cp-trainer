import { NextResponse } from "next/server";
import { one, q } from "@/lib/db";
import { getSessionResults } from "@/lib/icpc-queries";
import { getCurrentUser } from "@/lib/queries";

// PATCH { action: "end" }  — close the contest and every attempt still open in
// it, then return the scoreboard-style summary.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const sessionId = Number((await params).id);
  const body = await req.json().catch(() => ({}));

  if (body.action !== "end") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const owned = await one<{ id: number }>(
    "select id from contest_sessions where id = $1 and user_id = $2",
    [sessionId, user.id],
  );
  if (!owned) {
    return NextResponse.json({ error: "Contest not found." }, { status: 404 });
  }

  // Problems still being worked when time is called count as unsolved.
  await q(
    `update attempts set ended_at = now(), outcome = coalesce(outcome, 'gave_up')
     where session_id = $1 and user_id = $2 and ended_at is null`,
    [sessionId, user.id],
  );
  await q(
    `update contest_sessions set ended_at = now()
     where id = $1 and user_id = $2 and ended_at is null`,
    [sessionId, user.id],
  );

  return NextResponse.json({
    ok: true,
    results: await getSessionResults(user.id, sessionId),
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const sessionId = Number((await params).id);
  return NextResponse.json({
    results: await getSessionResults(user.id, sessionId),
  });
}
