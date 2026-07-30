"use client";

import { useEffect, useState } from "react";
import { useGuildLive } from "./GuildLive";
import { Avatar, Crown, Medal } from "./guild-ui";
import { useRankMotion } from "./useRankMotion";
import type { Standing } from "@/lib/guild-queries";

/*
  The guild board for one area, sized to sit beside the category header.

  What earns its space here is different from the full standings. Streak and
  30-day volume say nothing about who is strongest in Graphs, and the ±SE column
  is detail you go to /guild for. What's left is the ranking itself: place,
  face, name, and the one number being ranked on — which is exactly what makes
  a top ten readable in a third of the page width.

  Everyone rated in this area is ranked; the list shows ten. If you're below
  that, your row is pinned underneath with your real placement, because "you're
  14th" is the fact you came here for.

  Deliberately not sticky: a sticky element can only travel inside its own
  containing block, and this board is the taller of the two cards in that grid
  row — so it would have nowhere to stick to and the property would be a lie.
*/

const SHOWN = 10;

export default function GuildCategoryBoard({
  categorySlug,
  categoryName,
  meId,
  initial,
}: {
  categorySlug: string;
  categoryName: string;
  meId: number;
  initial: Standing[];
}) {
  const { version, live } = useGuildLive();
  const [rows, setRows] = useState(initial);

  useEffect(() => {
    if (version === 0) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(
        `/api/guild/standings?board=elo&category=cat-${categorySlug}`,
      );
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as { standings: Standing[] };
      if (!cancelled) setRows(body.standings);
    })();
    return () => {
      cancelled = true;
    };
  }, [categorySlug, version]);

  // Members with no estimate in this area aren't ranked here — an unrated row
  // would be noise, and the count below says how many are actually in contest.
  const rated = rows.filter((r) => r.value != null);
  const top = rated.slice(0, SHOWN);
  const myIndex = rated.findIndex((r) => r.user_id === meId);
  const me = myIndex >= 0 ? rated[myIndex] : null;
  const meBelow = myIndex >= SHOWN ? { row: rated[myIndex], rank: myIndex + 1 } : null;
  const leader = rated[0] ?? null;
  const gap =
    me && leader && me.user_id !== leader.user_id
      ? Math.round((leader.value ?? 0) - (me.value ?? 0))
      : null;

  return (
    <aside className="flex flex-col rounded-(--radius-card) border border-line bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Crown size={13} style={{ color: "var(--cat)" }} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
          {categoryName} · guild
        </span>
        <span
          aria-hidden
          className={`ml-auto size-1.5 shrink-0 rounded-full ${live ? "live-dot" : ""}`}
          style={{ backgroundColor: live ? "var(--accent)" : "var(--muted)" }}
          title={live ? "Live" : "Reconnecting…"}
        />
      </div>

      {rated.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted">
          Nobody in the guild has a rated estimate here yet — the crown is
          unclaimed.
        </p>
      ) : (
        <>
          <Rows rows={top} meId={meId} />

          {meBelow && (
            <div className="mt-2 mb-3 border-t border-dashed border-line pt-2">
              {/* Pinned, with its real placement: the whole reason to look. */}
              <Row row={meBelow.row} rank={meBelow.rank} meId={meId} delta={0} />
            </div>
          )}

          <div className="mt-3 border-t border-line pt-2.5 text-[11px] text-muted">
            {gap != null ? (
              <>
                <span className="num font-semibold text-ink">{gap}</span> points
                from the crown · {rated.length} rated here
              </>
            ) : me ? (
              <>You hold this area · {rated.length} rated here</>
            ) : (
              <>
                No estimate for you here yet · {rated.length} rated
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function Rows({ rows, meId }: { rows: Standing[]; meId: number }) {
  const { containerRef, deltas } = useRankMotion<HTMLOListElement>(rows);
  return (
    // `isolate`: a row mid-flight can travel outside the list's box, and
    // without its own stacking context it paints over everything above it.
    <ol ref={containerRef} className="isolate flex flex-col gap-0.5">
      {rows.map((r, i) => (
        <Row
          key={r.user_id}
          row={r}
          rank={i + 1}
          meId={meId}
          delta={deltas.get(r.user_id) ?? 0}
        />
      ))}
    </ol>
  );
}

function Row({
  row,
  rank,
  meId,
  delta,
}: {
  row: Standing;
  rank: number;
  meId: number;
  delta: number;
}) {
  const isMe = row.user_id === meId;
  return (
    <li
      data-user-id={row.user_id}
      data-rank={rank}
      className={`relative flex items-center gap-2 rounded-lg px-1.5 py-1 ${
        delta > 0 ? "rank-climb" : delta < 0 ? "rank-drop" : ""
      } ${isMe && delta > 0 ? "you-climbed" : ""}`}
      style={{
        backgroundColor: isMe ? "var(--accent-soft)" : "transparent",
        zIndex: delta !== 0 ? 2 : 1,
        willChange: "transform",
      }}
    >
      <Medal rank={rank} size={20} />
      <Avatar user={row} size={20} />
      <span
        className={`min-w-0 flex-1 truncate text-[13px] ${
          isMe ? "font-semibold text-accent-dk" : ""
        }`}
      >
        {isMe ? "You" : (row.display_name ?? row.github_login ?? "Member")}
      </span>
      <span className="num shrink-0 text-[13px] font-medium">
        {Math.round(row.value ?? 0)}
      </span>

      {delta !== 0 && (
        <span
          className="delta-pop num absolute -top-1.5 right-2 rounded px-1 text-[10px] font-bold text-white"
          style={{
            backgroundColor: delta > 0 ? "var(--streak-b)" : "var(--muted)",
          }}
        >
          {delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`}
        </span>
      )}
    </li>
  );
}
