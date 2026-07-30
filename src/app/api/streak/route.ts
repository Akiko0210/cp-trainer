import { NextResponse } from "next/server";
import { getRequestUser } from "@/lib/auth";
import {
  getActivityStrip,
  getStreak,
  nextMilestone,
} from "@/lib/queries";

/*
  Streak as JSON, for the header chip and the macOS menu bar app.

  Read-only and per-user, so it accepts either the session cookie or a paired
  device token (Authorization: Bearer). The menu bar app is not a browser and
  can never hold a cookie — before the token it simply got a 401 here and
  displayed a dash, which is exactly as useful as no app at all.
*/
export async function GET(req: Request) {
  const user = await getRequestUser(req);
  if (!user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const [streak, activity] = await Promise.all([
    getStreak(user.id),
    getActivityStrip(user.id),
  ]);

  return NextResponse.json(
    {
      handle: user.cf_handle,
      current: streak.current,
      longest: streak.longest,
      active_today: streak.active_today,
      last_active: streak.last_active,
      next_milestone: nextMilestone(streak.current, streak.longest),
      // Last two weeks, oldest first — enough for the menu bar dropdown.
      days: activity.slice(-14).map((d) => ({ day: d.day, active: d.active })),
    },
    // The menu bar polls this; never let a proxy hand it a stale streak.
    { headers: { "Cache-Control": "no-store" } },
  );
}
