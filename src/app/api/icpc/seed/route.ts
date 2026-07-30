import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { one } from "@/lib/db";
import { isOperator } from "@/lib/env";
import { WorkerOfflineError, workerPost } from "@/lib/worker";

// Refresh the Kattis ICPC archive. Batch job, not a monitor: Kattis publishes
// a new regional season roughly once a year.
//
// Operator-only: this is a several-minute crawl of someone else's website, and
// on a public URL an unguarded POST is an invitation to have this install used
// as a scraper.
export async function POST() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  if (!isOperator(user)) {
    return NextResponse.json(
      { error: "Only the install operator can refresh the ICPC archive." },
      { status: 403 },
    );
  }
  try {
    await workerPost("/seed-icpc");
    return NextResponse.json({ started: true });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof WorkerOfflineError
            ? "The sync worker isn't running — start it with `pnpm worker`."
            : e instanceof Error
              ? e.message
              : "Refresh failed.",
      },
      { status: 502 },
    );
  }
}

export async function GET() {
  // Counts only, and every signed-in member sees the same two numbers.
  if (!(await getSessionUser())) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const row = await one<{ sets: number; problems: number }>(
    `select (select count(*) from contest_sets)::int as sets,
            (select count(*) from contest_set_problems)::int as problems`,
  );
  return NextResponse.json(row);
}
