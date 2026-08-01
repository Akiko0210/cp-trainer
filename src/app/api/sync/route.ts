import { NextResponse } from "next/server";
import { workerConfigured } from "@/lib/env";
import { getCurrentUser, getSyncState } from "@/lib/queries";
import { WorkerOfflineError, workerPost } from "@/lib/worker";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const state = await getSyncState(user.id);
  return NextResponse.json(state ?? { status: null, submissions_total: 0 });
}

// Trigger a sync. ?quick=1 = small newest-page pull (awaited), used by the
// solve view to catch a fresh verdict; default = full incremental mirror.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const quick = new URL(req.url).searchParams.get("quick") === "1";
  if (!workerConfigured()) {
    // Not an error worth a 502: this deployment has no worker by design.
    return NextResponse.json(
      {
        error:
          "This deployment syncs on a schedule rather than on demand — your " +
          "Codeforces history refreshes within half an hour.",
        scheduled: true,
      },
      { status: 501 },
    );
  }
  try {
    const result = await workerPost(`/sync/${user.id}${quick ? "?quick=true" : ""}`);
    return NextResponse.json(result);
  } catch (e) {
    const offline = e instanceof WorkerOfflineError;
    return NextResponse.json(
      {
        error: offline
          ? "The sync worker isn't running — start it with `pnpm worker`."
          : e instanceof Error
            ? e.message
            : "Sync failed.",
      },
      { status: 502 },
    );
  }
}
