import { NextResponse } from "next/server";
import { one, q } from "@/lib/db";
import { getCurrentUser } from "@/lib/queries";

/*
  Manual solve marking, for judges we cannot read (Kattis). Recorded as a
  submissions row with source='manual' so every existing "is it solved" query
  keeps working, while staying distinguishable from the objective CF mirror.

  Refused for CF problems: those are mirrored from the judge, and letting the
  user assert a verdict the judge disagrees with would corrupt the one table
  that is supposed to be objective.
*/

async function loadProblem(id: number) {
  return one<{ id: number; source: string }>(
    "select id, source from problem_catalog where id = $1",
    [id],
  );
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const problemId = Number((await params).id);
  const problem = await loadProblem(problemId);
  if (!problem) {
    return NextResponse.json({ error: "Problem not found." }, { status: 404 });
  }
  if (problem.source === "cf") {
    return NextResponse.json(
      { error: "Codeforces solves come from the judge — run a sync instead." },
      { status: 400 },
    );
  }

  // external_submission_id is part of the uniqueness key; for manual rows the
  // problem id is a stable, collision-free choice (one manual solve each).
  await q(
    `insert into submissions
       (user_id, problem_id, verdict, submitted_at, source, external_submission_id)
     values ($1, $2, 'OK', now(), 'manual', $2)
     on conflict (user_id, source, external_submission_id) do nothing`,
    [user.id, problemId],
  );
  return NextResponse.json({ solved: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const problemId = Number((await params).id);
  await q(
    `delete from submissions
     where user_id = $1 and problem_id = $2 and source = 'manual'`,
    [user.id, problemId],
  );
  return NextResponse.json({ solved: false });
}
