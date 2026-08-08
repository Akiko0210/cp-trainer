"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FlameGlyph } from "./streak-ui";
import type { DayActivity, Streak } from "@/lib/queries";

/*
  The streak, in one slim band at the top of the dashboard.

  It used to be a 150px hero, which was the wrong trade: the streak is a
  *status*, not the page's subject — Mastery is — and a status that takes a
  fifth of the viewport pushes the thing you came for below the fold. So the
  same three states now read in a single row, and the two decorations that
  cost the most height are gone: the day-of-week letters under the strip (the
  tooltip already gives the exact date) and the stacked "Best" label.

  Three states, because the motivating moment is not "you have a streak" —
  it's "your streak is alive and today is still open":

    on-fire   live, today logged      -> warm gradient, flame breathing, sheen
    at-risk   live, today NOT logged  -> today's cell pulses, copy asks for one
    cold      no current streak       -> quiet, one clear way back in

  Motion is decorative only. Every number and state is also stated in text, so
  the band reads identically with prefers-reduced-motion on.
*/

export default function StreakBar({
  streak,
  activity,
}: {
  streak: Streak;
  activity: DayActivity[];
}) {
  const live = streak.current > 0;
  const atRisk = live && !streak.active_today;
  const onFire = live && streak.active_today;

  const shown = useCountUp(streak.current);
  const days = activity.slice(-14);
  const target = nextTarget(streak.current, streak.longest);
  const toGo = Math.max(0, target - streak.current);

  const dim = live ? "rgba(255,255,255,0.72)" : "var(--muted)";

  return (
    <section
      aria-label="Practice streak"
      className="relative mb-4 overflow-hidden rounded-(--radius-card) border"
      style={{
        borderColor: live ? "transparent" : "var(--line)",
        backgroundImage: live
          ? "linear-gradient(105deg, var(--streak-a), var(--streak-b))"
          : "none",
        backgroundColor: live ? undefined : "var(--card)",
      }}
    >
      {live && (
        <div
          aria-hidden
          className="streak-sheen pointer-events-none absolute inset-y-0 w-1/3"
          style={{
            backgroundImage:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.22), transparent)",
          }}
        />
      )}

      <div className="relative flex items-center gap-3 px-3.5 py-2.5 sm:gap-4 sm:px-4">
        <span
          aria-hidden
          className={`grid size-9 shrink-0 place-items-center rounded-xl ${
            onFire ? "streak-flicker" : ""
          }`}
          style={{ backgroundColor: live ? "rgba(255,255,255,0.16)" : "var(--card-2)" }}
        >
          <FlameGlyph
            size={20}
            outer={live ? "var(--streak-ink)" : "var(--streak-dim)"}
            inner={live ? "var(--streak-b)" : undefined}
          />
        </span>

        <div className="flex items-baseline gap-1.5">
          <span
            className="num text-[26px] font-bold leading-none tabular-nums"
            style={{ color: live ? "var(--streak-ink)" : "var(--muted)" }}
          >
            {shown}
          </span>
          <span className="text-xs font-medium" style={{ color: dim }}>
            day{streak.current === 1 ? "" : "s"}
          </span>
        </div>

        {/* The sentence is the nag; it's the first thing to go when narrow. */}
        <p className="hidden min-w-0 truncate text-[13px] sm:block" style={{ color: dim }}>
          {onFire &&
            (toGo > 0 ? (
              <>
                Today&apos;s in — <span className="num">{toGo}</span> more to hit{" "}
                <span className="num">{target}</span>.
              </>
            ) : (
              <>Today&apos;s in — that&apos;s a new record.</>
            ))}
          {atRisk && <>Not logged today — one solve keeps it alive.</>}
          {!live &&
            (streak.last_active
              ? "Your streak lapsed. One solve starts the next one."
              : "One solve starts your first streak.")}
        </p>

        <div className="ml-auto flex items-center gap-3 sm:gap-4">
          <div className="hidden items-center gap-[3px] lg:flex">
            {days.map((d, i) => {
              const isToday = i === days.length - 1;
              return (
                <span
                  key={d.day}
                  title={`${d.day}: ${d.active ? "practised" : "no practice"}`}
                  className={`block size-3.5 rounded-[4px] ${
                    isToday && atRisk ? "streak-pulse" : ""
                  }`}
                  style={{
                    backgroundColor: d.active
                      ? live
                        ? "rgba(255,255,255,0.92)"
                        : "var(--accent)"
                      : live
                        ? "rgba(255,255,255,0.22)"
                        : "var(--m0)",
                    outline: isToday
                      ? `1.5px solid ${live ? "rgba(255,255,255,0.75)" : "var(--accent)"}`
                      : undefined,
                    outlineOffset: 2,
                  }}
                />
              );
            })}
          </div>

          <span className="hidden text-[11px] sm:block" style={{ color: dim }}>
            best <span className="num font-semibold">{streak.longest}</span>
          </span>

          <Link
            href="/solve"
            className="shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-opacity hover:opacity-90"
            style={
              live
                ? { backgroundColor: "rgba(255,255,255,0.95)", color: "var(--streak-a)" }
                : { backgroundColor: "var(--accent)", color: "var(--accent-ink)" }
            }
          >
            {atRisk ? "Keep it alive" : onFire ? "Solve another" : "Start a streak"}
          </Link>
        </div>
      </div>
    </section>
  );
}

/* Count up to the real number on mount.

   Starts at 0 on both server and client so hydration matches, then the frame
   loop walks it to `target`. Reduced-motion users get duration 0, which lands
   the final number on the very first frame — same code path, no synchronous
   state write inside the effect. */
function useCountUp(target: number) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (target <= 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const durationMs = reduce ? 0 : Math.min(900, 220 + target * 45);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      // ease-out cubic: fast off the line, settles onto the number
      const t = durationMs === 0 ? 1 : Math.min(1, (now - start) / durationMs);
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return value;
}

const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];

function nextTarget(current: number, longest: number): number {
  const ring = MILESTONES.find((m) => m > current);
  const best = longest > current ? longest : null;
  const options = [ring, best].filter((n): n is number => n != null);
  return options.length
    ? Math.min(...options)
    : (Math.floor(current / 100) + 1) * 100;
}
