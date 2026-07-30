import { NextResponse } from "next/server";
import {
  getActivityStrip,
  getCurrentUser,
  getStreak,
  nextMilestone,
} from "@/lib/queries";

/*
  Streak as JSON. Read by the dashboard hero's live refresh and by the macOS
  menu bar app (menubar/), which is why it stays a plain unauthenticated
  localhost endpoint with a small, stable shape.
*/
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "No user yet." }, { status: 404 });
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
