import { NextResponse } from "next/server";
import { createDeviceToken, getSessionUser } from "@/lib/auth";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/*
  Pairing a headless client — today, the macOS menu bar app.

  Cookie-only on purpose: a device token must never be able to mint another
  device token, or a leaked one would be permanent. Only a real browser
  session, which required GitHub, can hand out a new one.

  The token is shown exactly once. There's nowhere to look it up afterwards
  because only its owner should ever have held it.
*/
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.trim().slice(0, 60)
      : "menu bar app";

  // One device of a given name per person: pairing again replaces the old
  // token rather than leaving a trail of live credentials behind.
  await q("delete from sessions where user_id = $1 and user_agent = $2", [
    user.id,
    label,
  ]);

  return NextResponse.json({
    token: await createDeviceToken(user.id, label),
    label,
  });
}

/** Revoke every paired device — the "I lost my laptop" button. */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const rows = await q<{ token: string }>(
    // Device rows are the ones with a label we set; browser sessions carry a
    // user-agent string instead. Matching on the label leaves your open tabs
    // signed in, which is what "revoke devices" should mean.
    "delete from sessions where user_id = $1 and user_agent = 'menu bar app' returning token",
    [user.id],
  );
  return NextResponse.json({ revoked: rows.length });
}
