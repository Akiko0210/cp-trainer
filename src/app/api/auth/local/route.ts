import { NextResponse } from "next/server";
import { createSession, oauthConfigured, safeNext } from "@/lib/auth";
import { one } from "@/lib/db";

/*
  Local development sign-in.

  Auth is required now that an install can be shared, but requiring a GitHub
  OAuth app just to open your own trainer on localhost would be a bad trade —
  so when OAuth is NOT configured and we're running `next dev`, this signs you
  in as the local account.

  Both guards matter. In production, or as soon as real OAuth credentials
  exist, this route 404s and the only way in is GitHub.
*/
function available(): boolean {
  return process.env.NODE_ENV === "development" && !oauthConfigured();
}

export async function POST(req: Request) {
  if (!available()) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Prefer the pre-existing local account so the mirrored Codeforces history
  // stays attached to whoever signs in here.
  let user = await one<{ id: number }>(
    "select id from users where github_id is null order by id limit 1",
  );
  if (!user) {
    user = await one<{ id: number }>(
      `insert into users (display_name) values ('Local user') returning id`,
    );
  }

  await createSession(user!.id, req.headers.get("user-agent") ?? undefined);
  const url = new URL(req.url);
  return NextResponse.redirect(
    new URL(safeNext(url.searchParams.get("next")), url.origin),
  );
}

export async function GET(req: Request) {
  return POST(req);
}
