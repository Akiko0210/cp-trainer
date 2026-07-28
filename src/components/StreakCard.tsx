import { Card, Label } from "@/components/ui";
import type { DayActivity, Streak } from "@/lib/queries";
import { daysAgo } from "@/lib/taxonomy";

/*
  Practice streak. Deliberately not a shame device: when the streak is broken
  the card says how to start a new one rather than how long you've been idle.
  The strip underneath is the same "active day" definition as the count, so
  the two can't contradict each other.
*/
export default function StreakCard({
  streak,
  activity,
}: {
  streak: Streak;
  activity: DayActivity[];
}) {
  const last14 = activity.slice(-14);
  const live = streak.current > 0;

  return (
    <Card>
      <Label>Practice streak</Label>
      <div className="flex items-baseline gap-2">
        <span
          className={`num text-[30px] font-bold leading-none ${
            live ? "" : "text-muted/50"
          }`}
        >
          {streak.current}
        </span>
        <span className="text-sm text-muted">
          {streak.current === 1 ? "day" : "days"}
        </span>
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        {live && streak.active_today && "Today's in. Keep it going."}
        {live && !streak.active_today && "Solve one today to extend it."}
        {!live &&
          (streak.last_active
            ? `Last practised ${daysAgo(streak.last_active)} — one solve starts a new one.`
            : "One solve starts your first streak.")}
      </p>

      <div className="mt-3 flex items-center gap-[3px]" aria-hidden>
        {last14.map((d) => (
          <span
            key={d.day}
            title={`${d.day}: ${d.active ? "practised" : "no practice"}`}
            className="h-5 flex-1 rounded-[3px]"
            style={{
              backgroundColor: d.active ? "var(--accent)" : "var(--m0)",
              opacity: d.active ? 1 : 1,
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted">
        <span>14 days ago</span>
        <span className="num">longest {streak.longest}</span>
      </div>
    </Card>
  );
}
