import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { getAttemptVerdicts, getCurrentUser } from "@/lib/queries";
import { workerPost } from "@/lib/worker";

// PATCH { action: "first_submit" } — provisional first-submit mark; the
//   judge's own timestamps overwrite it at the next reconcile (§3: objective
//   data wins on facts the judge records).
// PATCH { action: "finish", outcome: "ac" | "gave_up" } — close the session,
//   quick-sync to catch the fresh verdicts, return the judge's view of the
//   window so the UI can show what actually happened.
// DELETE — stop the session without recording anything (the timer's Stop
// button). Only open attempts can be discarded; tagged/closed ones stay.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const { id } = await params;
  const row = await one(
    `delete from attempts where id = $1 and user_id = $2 and ended_at is null
     returning id`,
    [Number(id), user.id],
  );
  if (!row) {
    return NextResponse.json({ error: "Attempt already closed." }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

// GET — re-check the judge's view of this attempt's window (quick sync first).
// Used by the solve view's "Check verdicts again" while CF is still judging.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const { id } = await params;
  let synced = false;
  try {
    await workerPost(`/sync/${user.id}?quick=true`);
    synced = true;
  } catch {}
  const verdicts = await getAttemptVerdicts(user.id, Number(id));
  return NextResponse.json({ synced, verdicts });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const { id } = await params;
  const attemptId = Number(id);
  const body = await req.json().catch(() => ({}));

  if (body.action === "first_submit") {
    await one(
      `update attempts set time_to_first_submit_s =
         extract(epoch from now() - started_at)::int
       where id = $1 and user_id = $2 and time_to_first_submit_s is null`,
      [attemptId, user.id],
    );
    return NextResponse.json({ ok: true });
  }

  if (body.action === "finish") {
    const outcome = body.outcome === "ac" ? "ac" : "gave_up";
    const row = await one<{ id: number }>(
      `update attempts set ended_at = now(), outcome = $3
       where id = $1 and user_id = $2 and ended_at is null returning id`,
      [attemptId, user.id, outcome],
    );
    if (!row) {
      return NextResponse.json({ error: "Attempt already closed." }, { status: 409 });
    }
    // Catch the verdicts that were just submitted (also reconciles + recomputes
    // mastery). Best-effort: the scheduler picks it up later if this fails.
    let synced = false;
    try {
      await workerPost(`/sync/${user.id}?quick=true`);
      synced = true;
    } catch {}
    const verdicts = await getAttemptVerdicts(user.id, attemptId);
    return NextResponse.json({ ok: true, synced, verdicts });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
