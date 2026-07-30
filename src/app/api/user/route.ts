import { NextResponse } from "next/server";
import { one, q } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { WorkerOfflineError, workerPost } from "@/lib/worker";

/*
  Link a Codeforces handle to the signed-in account.

  In v1 this created the single user row. Now identity comes from GitHub, so
  this only attaches (or changes) the handle — and it refuses a handle already
  claimed by someone else, because two members sharing a handle would make the
  club leaderboard meaningless.
*/
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { handle } = await req.json().catch(() => ({}));
  if (!handle || typeof handle !== "string") {
    return NextResponse.json({ error: "Enter a Codeforces handle." }, { status: 400 });
  }

  let info: {
    handle: string;
    rating: number | null;
    maxRating: number | null;
    rank: string | null;
  };
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

  const taken = await one<{ id: number }>(
    "select id from users where lower(cf_handle) = lower($1) and id <> $2",
    [info.handle, user.id],
  );
  if (taken) {
    return NextResponse.json(
      { error: `${info.handle} is already linked to another member.` },
      { status: 409 },
    );
  }

  await q(
    `update users set cf_handle = $1, cf_rating = $2, cf_max_rating = $3,
                      cf_rank = $4
     where id = $5`,
    [info.handle, info.rating, info.maxRating, info.rank, user.id],
  );

  try {
    await workerPost(`/sync/${user.id}`);
  } catch {
    // Sync is retryable from settings; the link itself succeeded.
  }
  return NextResponse.json({ id: user.id, handle: info.handle });
}
