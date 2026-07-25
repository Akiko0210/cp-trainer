import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { WorkerOfflineError, workerPost } from "@/lib/worker";

// Refresh the Kattis ICPC archive. Batch job, not a monitor: Kattis publishes
// a new regional season roughly once a year.
export async function POST() {
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
  const row = await one<{ sets: number; problems: number }>(
    `select (select count(*) from contest_sets)::int as sets,
            (select count(*) from contest_set_problems)::int as problems`,
  );
  return NextResponse.json(row);
}
