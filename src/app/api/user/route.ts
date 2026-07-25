import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { WorkerOfflineError, workerPost } from "@/lib/worker";

// Onboarding: validate the handle against CF (via the worker), create the
// user, kick off the first full mirror.
export async function POST(req: Request) {
  const { handle } = await req.json().catch(() => ({}));
  if (!handle || typeof handle !== "string") {
    return NextResponse.json({ error: "Enter a Codeforces handle." }, { status: 400 });
  }

  let info: { handle: string; rating: number | null; maxRating: number | null; rank: string | null };
  try {
    info = await workerPost(`/validate-handle/${encodeURIComponent(handle)}`);
  } catch (e) {
    if (e instanceof WorkerOfflineError) {
      return NextResponse.json(
        { error: "The sync worker isn't running — start it with `pnpm worker` and retry." },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Handle check failed." },
      { status: 404 },
    );
  }

  const user = await one<{ id: number }>(
    `insert into users (cf_handle, display_name, cf_rating, cf_max_rating, cf_rank)
     values ($1, $1, $2, $3, $4)
     on conflict (cf_handle) do update set cf_rating = excluded.cf_rating
     returning id`,
    [info.handle, info.rating, info.maxRating, info.rank],
  );

  try {
    await workerPost(`/sync/${user!.id}`);
  } catch {
    // Sync can be retried from settings; account creation still succeeded.
  }
  return NextResponse.json({ id: user!.id, handle: info.handle });
}
