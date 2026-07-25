import { NextResponse } from "next/server";
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
