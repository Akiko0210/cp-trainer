import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { fetchHandleInfo, HandleNotFound } from "@/lib/cf";
import { bindCf, unbindCf } from "@/lib/cf-account";
import { one } from "@/lib/db";
import { workerConfigured } from "@/lib/env";
import { WorkerOfflineError, workerPost } from "@/lib/worker";

/*
  Link a Codeforces handle to the signed-in account.

  In v1 this created the single user row. Now identity comes from GitHub, so
  this only attaches (or changes) the handle — and it refuses a handle already
  claimed by someone else, because two members sharing a handle would make the
  club leaderboard meaningless. Changing to a *different* handle purges the
  old one's mirrored history first (see lib/cf-account); DELETE unbinds.
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
    // Prefer the worker where one exists — its queue is what keeps the whole
    // install inside the Codeforces rate limit. With no worker (a serverless
    // deployment) this is the one lookup the app makes for itself; see lib/cf.
    info = workerConfigured()
      ? await workerPost(`/validate-handle/${encodeURIComponent(handle)}`)
      : await fetchHandleInfo(handle);
  } catch (e) {
    if (e instanceof WorkerOfflineError) {
      // Only reachable on an install that HAS a worker, so the advice applies.
      return NextResponse.json(
        { error: "The sync worker isn't running — start it with `pnpm worker` and retry." },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Handle check failed." },
      { status: e instanceof HandleNotFound ? 404 : 502 },
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

  await bindCf(user.id, info, user.cf_handle);

  // Kick off the first mirror where there is something to kick. Where there
  // isn't, the scheduled sync picks the member up on its next pass — so the
  // answer says which world this is and the UI can set expectations rather
  // than leaving someone staring at an empty dashboard wondering.
  let syncing = false;
  if (workerConfigured()) {
    try {
      await workerPost(`/sync/${user.id}`);
      syncing = true;
    } catch {
      // Retryable from Settings; the link itself succeeded.
    }
  }
  return NextResponse.json({ id: user.id, handle: info.handle, syncing });
}

// Unbind. Removes the mirrored CF history along with the handle (it is that
// handle's history, not this account's); attempts, mistake tags and manual
// Kattis solves stay. Idempotent — unbinding an unbound account is a no-op.
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  await unbindCf(user.id);
  return NextResponse.json({ ok: true });
}
