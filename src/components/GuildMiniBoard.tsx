"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useGuildLive } from "./GuildLive";
import { Avatar, Crown } from "./guild-ui";
import type { Standing } from "@/lib/guild-queries";

/*
  The guild board, small enough to live on the dashboard.

  Top three plus your own row when you're below it — the two facts you actually
  want at a glance: who's ahead, and how far. Live, from the same stream as
  everything else, so the dashboard is never showing a stale order.
*/
export default function GuildMiniBoard({
  meId,
  guildName,
  initial,
}: {
  meId: number;
  guildName: string;
  initial: Standing[];
}) {
  const { version, live } = useGuildLive();
  const [rows, setRows] = useState(initial);

  useEffect(() => {
    if (version === 0) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/guild/standings?board=elo");
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as { standings: Standing[] };
      if (!cancelled) setRows(body.standings);
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  const myIndex = rows.findIndex((s) => s.user_id === meId);
  const top = rows.slice(0, 3);
  // Your row again, only if it isn't already up there.
  const tail = myIndex >= 3 ? [{ row: rows[myIndex], rank: myIndex + 1 }] : [];

  return (
    <div className="rounded-(--radius-card) border border-line bg-card p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
          Guild
        </span>
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${live ? "live-dot" : ""}`}
          style={{ backgroundColor: live ? "var(--accent)" : "var(--muted)" }}
          title={live ? "Live" : "Reconnecting…"}
        />
        <Link
          href="/guild"
          className="ml-auto truncate text-[11px] text-muted hover:text-accent"
        >
          {guildName} →
        </Link>
      </div>

      <ul className="flex flex-col">
        {[...top.map((row, i) => ({ row, rank: i + 1 })), ...tail].map(
          ({ row, rank }) => {
            const isMe = row.user_id === meId;
            return (
              <li
                key={row.user_id}
                className="flex items-center gap-2 py-1.5"
                style={{
                  // A separator, not a gap: your row after a jump shouldn't look
                  // like rank 4.
                  borderTop:
                    rank > 3 ? "1px dashed var(--line)" : undefined,
                  marginTop: rank > 3 ? "0.25rem" : undefined,
                  paddingTop: rank > 3 ? "0.5rem" : undefined,
                }}
              >
                <span className="num w-4 shrink-0 text-xs text-muted">
                  {rank}
                </span>
                <Avatar user={row} size={22} />
                <span
                  className={`min-w-0 flex-1 truncate text-[13px] ${
                    isMe ? "font-semibold text-accent-dk" : ""
                  }`}
                >
                  {isMe ? "You" : (row.display_name ?? row.github_login)}
                </span>
                {row.crowns > 0 && (
                  <span
                    className="num flex shrink-0 items-center gap-0.5 text-[10px]"
                    style={{ color: "var(--streak-b)" }}
                    title={`Strongest in ${row.crowns} area${row.crowns === 1 ? "" : "s"}`}
                  >
                    <Crown size={10} />
                    {row.crowns}
                  </span>
                )}
                <span className="num shrink-0 text-[13px] font-medium">
                  {row.value != null ? Math.round(row.value) : "—"}
                </span>
              </li>
            );
          },
        )}
      </ul>
    </div>
  );
}
