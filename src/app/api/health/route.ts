import { NextResponse } from "next/server";
import { one } from "@/lib/db";

export const dynamic = "force-dynamic";

/*
  Liveness for the platform's health check, and the first thing to curl when
  something looks wrong.

  It touches the database on purpose: a web process that answers but can't
  reach Postgres is not healthy, and letting a platform keep routing traffic to
  it just turns one broken deploy into a wall of 500s. Unauthenticated, and it
  says nothing a stranger could use — a boolean and a version string.
*/
export async function GET() {
  const started = Date.now();
  try {
    await one("select 1");
    return NextResponse.json(
      {
        ok: true,
        db_ms: Date.now() - started,
        commit: process.env.GIT_COMMIT?.slice(0, 7) ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "database unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
