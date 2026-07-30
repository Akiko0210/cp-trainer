"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useGuildLive } from "./GuildLive";
import { FlameGlyph } from "./streak-ui";
import type { Streak } from "@/lib/queries";

/*
  The streak, in the header, on every page — the same readout as the menu bar
  app, for when you're already in the browser.

  Same three states as the dashboard hero, because a streak that looked
  different in two places would read as two different things:

    on-fire   today logged      -> the streak gradient, flame breathing
    at-risk   alive, today open -> outlined, flame pulsing, "!" after the count
    cold      no streak         -> quiet, and the number is 0 rather than gone

  It links to /solve rather than to the dashboard: from any page that isn't the
  dashboard, the useful response to seeing "4!" is to go and solve something,
  and the hero is one click away anyway.

  Refresh: the guild's live stream covers your own solves the moment the worker
  mirrors them, and a focus listener covers a solo install with no guild — plus
  a slow poll while the tab is visible, because a streak can also flip to
  at-risk with nobody touching anything, at midnight.
*/

const POLL_MS = 5 * 60 * 1000;

export default function StreakChip({ initial }: { initial: Streak }) {
  const { version } = useGuildLive();
  const [streak, setStreak] = useState(initial);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch("/api/streak");
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as Streak;
      if (!cancelled) setStreak(body);
    };

    // Not on version 0: that's the server-rendered value we already have.
    if (version > 0) void load();

    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(onVisible, POLL_MS);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [version]);

  const live = streak.current > 0;
  const atRisk = live && !streak.active_today;
  const onFire = live && streak.active_today;

  const label = onFire
    ? `${streak.current}-day streak, today logged`
    : atRisk
      ? `${streak.current}-day streak — not logged today. One solve keeps it.`
      : "No streak. One solve starts one.";

  return (
    <Link
      href="/solve"
      title={label}
      aria-label={label}
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-semibold"
      style={{
        // On fire, the chip *is* the gradient — the one element in the header
        // that changes colour, so a lit streak is visible in peripheral vision.
        backgroundImage: onFire
          ? "linear-gradient(105deg, var(--streak-a), var(--streak-b))"
          : "none",
        backgroundColor: onFire ? undefined : "var(--card)",
        borderColor: onFire
          ? "transparent"
          : atRisk
            ? "color-mix(in oklab, var(--streak-b) 55%, transparent)"
            : "var(--line)",
        color: onFire ? "var(--streak-ink)" : atRisk ? "var(--streak-b)" : "var(--muted)",
      }}
    >
      <span className={onFire ? "streak-flicker" : atRisk ? "streak-pulse" : ""}>
        <FlameGlyph size={13} />
      </span>
      <span className="num leading-none tabular-nums">
        {streak.current}
        {/* The nag, in one character: alive, but today is still open. */}
        {atRisk && <span aria-hidden>!</span>}
      </span>
    </Link>
  );
}
