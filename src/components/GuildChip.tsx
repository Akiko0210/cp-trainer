"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useGuildLive } from "./GuildLive";
import { Crest, Crown } from "./guild-ui";
import type { MyStanding } from "@/lib/guild-queries";

/*
  The guild, in the header, on every page.

  This is the point of a single affiliation: your standing is a fact about you,
  not a page you visit. It sits next to the Codeforces rating chip because it is
  the same kind of fact, and it moves on its own — when the board reorders under
  you, the chip pops and shows which way you went, so a change reaches you even
  when you're deep in a category page or mid-attempt.
*/

type Guild = { slug: string; name: string; member_count: number };

export default function GuildChip({
  guild,
  standing,
}: {
  guild: Guild;
  standing: MyStanding;
}) {
  const { version, live } = useGuildLive();
  const [now, setNow] = useState<MyStanding>(standing);
  const [delta, setDelta] = useState(0);
  const prev = useRef<number | null>(standing.rank);

  useEffect(() => {
    if (version === 0) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/guild/me");
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as { standing: MyStanding | null };
      if (cancelled || !body.standing) return;
      setNow(body.standing);
      const before = prev.current;
      // Lower rank number = better, so a climb is (before - after).
      if (before != null && body.standing.rank != null && before !== body.standing.rank) {
        setDelta(before - body.standing.rank);
      }
      prev.current = body.standing.rank;
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    if (delta === 0) return;
    const timer = setTimeout(() => setDelta(0), 4000);
    return () => clearTimeout(timer);
  }, [delta]);

  const rank = now.rank;
  const title =
    `${guild.name} — ` +
    (rank ? `#${rank} of ${now.members}` : `${now.members} members`) +
    (now.crowns > 0
      ? `, ${now.crowns} area${now.crowns === 1 ? "" : "s"} held`
      : "") +
    (live ? " · live" : "");

  return (
    <Link
      href="/guild"
      title={title}
      className={`relative flex items-center gap-2 rounded-full border border-line bg-card p-1 pr-2.5 text-sm hover:border-accent/50 ${
        delta > 0 ? "you-climbed" : ""
      }`}
    >
      <Crest name={guild.name} slug={guild.slug} size={22} />

      <span className="num flex items-center gap-1.5 font-medium leading-none">
        {rank ? `#${rank}` : "—"}
        {now.crowns > 0 && (
          <span
            className="flex items-center gap-0.5 text-[11px]"
            style={{ color: "var(--streak-b)" }}
          >
            <Crown size={11} />
            {now.crowns}
          </span>
        )}
      </span>

      {/* Connection state, not decoration: a stale board should be visible. */}
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${live ? "live-dot" : ""}`}
        style={{ backgroundColor: live ? "var(--accent)" : "var(--muted)" }}
      />

      {delta !== 0 && (
        <span
          className="delta-pop num absolute -bottom-2 right-1 rounded px-1 text-[10px] font-bold text-white"
          style={{
            backgroundColor: delta > 0 ? "var(--streak-b)" : "var(--muted)",
          }}
        >
          {delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`}
        </span>
      )}
    </Link>
  );
}
