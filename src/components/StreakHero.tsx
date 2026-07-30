"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FlameGlyph } from "./streak-ui";
import type { DayActivity, Streak } from "@/lib/queries";

/*
  The streak, given the top of the dashboard.

  Three states, because the motivating moment is not "you have a streak" — it's
  "your streak is alive and today is still open":

    on-fire   live, today logged      -> warm gradient, flame breathing, sheen
    at-risk   live, today NOT logged  -> today's cell pulses, copy asks for one solve
    cold      no current streak       -> quiet, one clear way back in

  Motion is decorative only. Every number and state is also stated in text, so
  the band reads identically with prefers-reduced-motion on.
*/

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

export default function StreakHero({
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
      {/* the sheen, only while the streak is alive */}
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

      <div className="relative flex flex-wrap items-center gap-x-8 gap-y-5 p-5 sm:p-6">
        {/* ---- the number ---- */}
        <div className="flex items-center gap-4">
          <Flame lit={live} atRisk={atRisk} />
          <div>
            <div className="flex items-baseline gap-2">
              <span
                className="num text-[52px] font-bold leading-none tracking-tight tabular-nums"
                style={{ color: live ? "var(--streak-ink)" : "var(--muted)" }}
              >
                {shown}
              </span>
              <span
                className="text-sm font-medium"
                style={{
                  color: live ? "rgba(255,255,255,0.85)" : "var(--muted)",
                }}
              >
                day{streak.current === 1 ? "" : "s"}
              </span>
            </div>
            <div
              className="mt-1 text-[13px]"
              style={{
                color: live ? "rgba(255,255,255,0.9)" : "var(--muted)",
              }}
            >
              {onFire && (
                <>
                  Today&apos;s in.{" "}
                  {toGo > 0 ? (
                    <>
                      <span className="num">{toGo}</span> more to hit{" "}
                      <span className="num">{target}</span>.
                    </>
                  ) : (
                    <>That&apos;s a new record.</>
                  )}
                </>
              )}
              {atRisk && (
                <>
                  Not logged today — one solve keeps{" "}
                  <span className="num">{streak.current}</span> alive.
                </>
              )}
              {!live &&
                (streak.last_active
                  ? "Your streak lapsed. One solve starts the next one."
                  : "One solve starts your first streak.")}
            </div>
          </div>
        </div>

        {/* ---- the last two weeks ---- */}
        <div className="flex items-end gap-[5px]">
          {days.map((d, i) => {
            const isToday = i === days.length - 1;
            const dow = new Date(`${d.day}T12:00:00Z`).getUTCDay();
            return (
              <div key={d.day} className="flex flex-col items-center gap-1.5">
                <span
                  title={`${d.day}: ${d.active ? "practised" : "no practice"}`}
                  className={`block size-6 rounded-[6px] ${
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
                      ? `2px solid ${live ? "rgba(255,255,255,0.75)" : "var(--accent)"}`
                      : undefined,
                    outlineOffset: 2,
                  }}
                />
                <span
                  className="num text-[10px]"
                  style={{
                    color: live ? "rgba(255,255,255,0.6)" : "var(--muted)",
                  }}
                >
                  {DAY_LETTERS[dow]}
                </span>
              </div>
            );
          })}
        </div>

        {/* ---- record + action ---- */}
        <div className="ml-auto flex items-center gap-5">
          <div className="text-right">
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.12em]"
              style={{
                color: live ? "rgba(255,255,255,0.7)" : "var(--muted)",
              }}
            >
              Best
            </div>
            <div
              className="num text-[22px] font-semibold leading-none"
              style={{ color: live ? "var(--streak-ink)" : "var(--ink)" }}
            >
              {streak.longest}
            </div>
          </div>
          <Link
            href="/solve"
            className="rounded-xl px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90"
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

function Flame({ lit, atRisk }: { lit: boolean; atRisk: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid size-14 shrink-0 place-items-center rounded-2xl ${
        lit && !atRisk ? "streak-flicker" : ""
      }`}
      style={{
        backgroundColor: lit ? "rgba(255,255,255,0.16)" : "var(--card-2)",
      }}
    >
      <FlameGlyph
        size={32}
        outer={lit ? "var(--streak-ink)" : "var(--streak-dim)"}
        outerOpacity={lit ? 0.95 : 1}
        inner={lit ? "var(--streak-b)" : "var(--card)"}
      />
    </span>
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
