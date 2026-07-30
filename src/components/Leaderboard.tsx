"use client";

import { useEffect, useState } from "react";
import { useGuildLive } from "./GuildLive";
import Select from "./Select";
import { Avatar, Crown, Medal } from "./guild-ui";
import { useRankMotion } from "./useRankMotion";
import type { GuildActivity, Standing } from "@/lib/guild-queries";
import { CATEGORIES, daysAgo } from "@/lib/taxonomy";

/*
  The live guild leaderboard.

  Two things make it feel alive rather than merely fresh:

  1. FLIP. When the order changes we measure every row's box before the DOM
     updates and again after, then apply the inverse transform and release it.
     The row physically travels from its old rank to its new one, so a member
     watching sees the overtake happen instead of noticing a different list.

  2. Deltas. A row that moved carries a "▲2 / ▼1" badge for a couple of
     seconds, and your own row gets a ring pulse when you climb. Without that,
     a reorder you weren't staring at is invisible.

  Data flow: fetch standings, then re-fetch when the app-wide live stream
  (GuildLive) says something moved. The server never pushes a whole board — it
  pushes "member X moved", which keeps payloads tiny and leaves the ranking in
  SQL, where it can't drift from the champions grid.
*/

type Payload = {
  standings: Standing[];
  activity: GuildActivity[];
};

const BOARDS = [
  { id: "elo", label: "Ability", hint: "fitted rating" },
  { id: "streak", label: "Streak", hint: "consecutive days" },
  { id: "solved", label: "Solved · 30d", hint: "problems cleared" },
] as const;

export default function Leaderboard({
  meId,
  initial,
}: {
  meId: number;
  initial: Payload;
}) {
  const { version, live, pulse } = useGuildLive();
  const [board, setBoard] = useState<string>("elo");
  const [category, setCategory] = useState<string>("");
  const [data, setData] = useState<Payload>(initial);

  useEffect(() => {
    // The initial payload is already the "elo, all topics, version 0" answer.
    if (version === 0 && board === "elo" && !category) return;
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams({ board });
      if (category) params.set("category", category);
      const res = await fetch(`/api/guild/standings?${params}`);
      if (res.ok && !cancelled) setData(await res.json());
    })();
    // Guards against a slow response for the previous tab landing after a
    // faster one for the tab you actually switched to.
    return () => {
      cancelled = true;
    };
  }, [board, category, version]);

  const ranked = data.standings;
  const myRank = ranked.findIndex((s) => s.user_id === meId) + 1;

  return (
    <div className="flex flex-col gap-4">
      {/* ---- controls ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Leaderboard"
          className="flex gap-1 rounded-(--radius-chip) bg-card-2 p-1"
        >
          {BOARDS.map((b) => (
            <button
              key={b.id}
              role="tab"
              aria-selected={board === b.id}
              title={b.hint}
              onClick={() => setBoard(b.id)}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                board === b.id
                  ? "bg-card font-medium text-ink shadow-sm"
                  : "text-muted hover:text-ink"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        {board === "elo" && (
          <Select
            ariaLabel="Narrow to one area"
            className="w-48"
            value={category}
            onChange={setCategory}
            options={[
              { value: "", label: "All areas" },
              ...CATEGORIES.map((c) => ({
                value: `cat-${c.slug}`,
                label: c.name,
              })),
            ]}
          />
        )}

        <span
          className="ml-auto flex items-center gap-2 text-xs text-muted"
          title={
            live
              ? "Connected — the board updates as people solve"
              : "Reconnecting…"
          }
        >
          <span
            className={`size-2 rounded-full ${live ? "live-dot" : ""}`}
            style={{ backgroundColor: live ? "var(--accent)" : "var(--muted)" }}
          />
          {live ? "Live" : "Offline"}
          {pulse && live && <span className="text-accent">· something moved</span>}
        </span>
      </div>

      <Rows rows={ranked} meId={meId} board={board} />

      {/* Your own position, always reachable even in a long roster. */}
      {myRank > 0 && (
        <div className="text-xs text-muted">
          You&apos;re <span className="num font-semibold text-ink">#{myRank}</span>{" "}
          of <span className="num">{ranked.length}</span> on this board.
        </div>
      )}

      {data.activity.length > 0 && (
        <div className="rounded-(--radius-card) border border-line bg-card p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            Latest solves
          </div>
          <ul className="flex flex-col gap-1.5">
            {data.activity.slice(0, 6).map((a, i) => (
              <li
                key={`${a.user_id}-${a.submitted_at}-${i}`}
                className="flex items-center gap-2 text-[13px]"
              >
                <Avatar user={a} size={18} />
                <span className="font-medium">
                  {a.display_name ?? "Someone"}
                </span>
                <span className="text-muted">solved</span>
                <a
                  href={a.url ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate hover:text-accent"
                >
                  {a.title ?? "a problem"}
                </a>
                {a.rating != null && (
                  <span className="num text-xs text-muted">{a.rating}</span>
                )}
                <span className="num ml-auto shrink-0 text-xs text-muted">
                  {daysAgo(a.submitted_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---- the animated rows ---- */

function Rows({
  rows,
  meId,
  board,
}: {
  rows: Standing[];
  meId: number;
  board: string;
}) {
  // FLIP + delta badges, shared with the compact category board.
  const { containerRef, deltas } = useRankMotion<HTMLOListElement>(rows);

  if (rows.length === 0) {
    return (
      <div className="rounded-(--radius-card) border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
        No members yet. Share the invite code to fill the board.
      </div>
    );
  }

  return (
    // `isolate` keeps a row that is mid-flight from painting over the page
    // header: a translated row can travel well outside the list's box, and
    // without its own stacking context it lands on top of everything above it.
    <ol ref={containerRef} className="isolate flex flex-col gap-1.5">
      {rows.map((s, i) => {
        const rank = i + 1;
        const delta = deltas.get(s.user_id) ?? 0;
        const isMe = s.user_id === meId;
        return (
          <li
            key={s.user_id}
            data-user-id={s.user_id}
            data-rank={rank}
            className={`relative flex items-center gap-3 rounded-(--radius-card) border px-3 py-2.5 ${
              delta > 0 ? "rank-climb" : delta < 0 ? "rank-drop" : ""
            } ${isMe && delta > 0 ? "you-climbed" : ""}`}
            style={{
              borderColor: isMe ? "var(--accent)" : "var(--line)",
              backgroundColor: isMe ? "var(--accent-soft)" : "var(--card)",
              // Opaque and layered so rows crossing each other never show
              // through one another mid-animation.
              zIndex: delta !== 0 ? 2 : 1,
              willChange: "transform",
            }}
          >
            <Medal rank={rank} />
            <Avatar user={s} size={30} />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {s.display_name ?? s.github_login ?? "Member"}
                  {isMe && <span className="ml-1.5 text-xs text-accent">you</span>}
                </span>
                {s.role && s.role !== "member" && (
                  <span className="rounded-md bg-card-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    {s.role}
                  </span>
                )}
                {s.crowns > 0 && (
                  <span
                    className="num flex shrink-0 items-center gap-0.5 text-[11px] font-semibold"
                    style={{ color: "var(--streak-b)" }}
                    title={`Strongest in ${s.crowns} area${s.crowns === 1 ? "" : "s"}`}
                  >
                    <Crown size={11} />
                    {s.crowns}
                  </span>
                )}
              </div>
              <div className="num mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                {s.cf_handle ? (
                  <>
                    <span className="truncate">{s.cf_handle}</span>
                    {s.cf_rating != null && <span>· cf {s.cf_rating}</span>}
                  </>
                ) : (
                  <span className="font-sans">Codeforces handle not linked</span>
                )}
              </div>
            </div>

            <div className="hidden shrink-0 items-center gap-4 sm:flex">
              <Mini label="streak" value={s.streak} />
              <Mini label="30d" value={s.solved_30d} />
            </div>

            <div className="w-24 shrink-0 text-right">
              <div className="num text-[19px] font-semibold leading-none">
                {s.value != null ? Math.round(s.value) : "—"}
              </div>
              {board === "elo" && s.se != null && (
                <div className="num text-[10px] text-muted">
                  ±{Math.round(s.se)}
                </div>
              )}
            </div>

            {delta !== 0 && (
              <span
                className="delta-pop num absolute -top-2 right-3 rounded-md px-1.5 py-0.5 text-[11px] font-bold text-white"
                style={{
                  backgroundColor:
                    delta > 0 ? "var(--streak-b)" : "var(--muted)",
                }}
              >
                {delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-right">
      <div className="num text-sm font-medium leading-none">{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}
