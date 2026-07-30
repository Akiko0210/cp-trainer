"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Select from "@/components/Select";
import type { GroupActivity, Standing } from "@/lib/group-queries";
import { CATEGORIES, daysAgo } from "@/lib/taxonomy";

/*
  The live club leaderboard.

  Two things make it feel alive rather than merely fresh:

  1. FLIP. When the order changes we measure every row's box before the DOM
     updates and again after, then apply the inverse transform and release it.
     The row physically travels from its old rank to its new one, so a member
     watching sees the overtake happen instead of noticing a different list.

  2. Deltas. A row that moved carries a "+2 / -1" badge for a couple of
     seconds, and your own row gets a ring pulse when you climb. Without that,
     a reorder you weren't staring at is invisible.

  Data flow: fetch standings once, then an EventSource on the group's SSE
  stream tells us something moved and we re-fetch. The server never pushes the
  whole board — it pushes "user X changed", which keeps the payload tiny and
  the ranking logic in one place (SQL).
*/

type Payload = {
  standings: Standing[];
  activity: GroupActivity[];
};

const BOARDS = [
  { id: "elo", label: "Ability", hint: "fitted rating" },
  { id: "streak", label: "Streak", hint: "consecutive days" },
  { id: "solved", label: "Solved · 30d", hint: "problems cleared" },
] as const;

export default function Leaderboard({
  slug,
  meId,
  initial,
}: {
  slug: string;
  meId: number;
  initial: Payload;
}) {
  const [board, setBoard] = useState<string>("elo");
  const [category, setCategory] = useState<string>("");
  const [data, setData] = useState<Payload>(initial);
  const [live, setLive] = useState(false);
  const [flash, setFlash] = useState(false);

  // Bumped by the live stream to request a re-fetch. Keeping it as a dep
  // (rather than calling a fetcher from inside the stream handler) means every
  // load goes through one code path with one cancellation rule.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams({ board });
      if (category) params.set("category", category);
      const res = await fetch(`/api/groups/${slug}/standings?${params}`);
      if (res.ok && !cancelled) setData(await res.json());
    })();
    // Guards against a slow response for the previous tab landing after a
    // faster one for the tab you actually switched to.
    return () => {
      cancelled = true;
    };
  }, [slug, board, category, refreshKey]);

  // Live updates. Coalesced: a Codeforces sync can fire many notifications in
  // a burst, and re-fetching per event would hammer the DB for no visual gain.
  useEffect(() => {
    const source = new EventSource(`/api/groups/${slug}/stream`);
    let pending: ReturnType<typeof setTimeout> | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;

    source.addEventListener("ready", () => setLive(true));
    source.addEventListener("standings", () => {
      setFlash(true);
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => setFlash(false), 900);
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => setRefreshKey((k) => k + 1), 400);
    });
    source.onerror = () => setLive(false);

    return () => {
      if (pending) clearTimeout(pending);
      if (flashTimer) clearTimeout(flashTimer);
      source.close();
    };
  }, [slug]);

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
            ariaLabel="Narrow to a topic area"
            className="w-48"
            value={category}
            onChange={setCategory}
            options={[
              { value: "", label: "All topics" },
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
            style={{
              backgroundColor: live ? "var(--ac)" : "var(--muted)",
            }}
          />
          {live ? "Live" : "Offline"}
          {flash && live && (
            <span className="text-accent">· something moved</span>
          )}
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
  const containerRef = useRef<HTMLOListElement>(null);
  // Previous geometry and ranks, keyed by user, for the FLIP + delta badges.
  const boxes = useRef<Map<number, number>>(new Map());
  const prevRank = useRef<Map<number, number>>(new Map());
  const [deltas, setDeltas] = useState<Map<number, number>>(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const moved = new Map<number, number>();

    for (const el of Array.from(container.children) as HTMLElement[]) {
      const id = Number(el.dataset.userId);
      // offsetTop, not getBoundingClientRect().top: the rect is viewport-
      // relative, so any scroll between two renders would make every stored
      // position stale and give every row a bogus transform. offsetTop is
      // measured from the offset parent and is unaffected by scrolling.
      const top = el.offsetTop;
      const before = boxes.current.get(id);

      if (before != null && Math.abs(before - top) > 1 && !reduce) {
        // Invert to the old position, then let it travel to the new one.
        el.style.transition = "none";
        el.style.transform = `translateY(${before - top}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 620ms cubic-bezier(0.22, 1, 0.36, 1)";
          el.style.transform = "";
        });
      }
      boxes.current.set(id, top);

      const rankNow = Number(el.dataset.rank);
      const rankBefore = prevRank.current.get(id);
      if (rankBefore != null && rankBefore !== rankNow) {
        moved.set(id, rankBefore - rankNow); // positive = climbed
      }
      prevRank.current.set(id, rankNow);
    }

    if (moved.size > 0) {
      // Deferred a frame: the badges are decoration on top of a layout pass
      // that has already been measured, and writing state synchronously here
      // would mean re-rendering mid-measurement.
      const raf = requestAnimationFrame(() => setDeltas(moved));
      const timer = setTimeout(() => setDeltas(new Map()), 2400);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
  }, [rows]);

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
                {s.role !== "member" && (
                  <span className="rounded-md bg-card-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    {s.role}
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

function Medal({ rank }: { rank: number }) {
  // Only the podium gets a treatment; ranks 4+ stay quiet so the top actually
  // reads as the top.
  const tone =
    rank === 1
      ? { bg: "var(--streak-b)", fg: "#fff" }
      : rank === 2
        ? { bg: "var(--streak-a)", fg: "#fff" }
        : rank === 3
          ? { bg: "var(--accent-soft)", fg: "var(--accent-dk)" }
          : { bg: "transparent", fg: "var(--muted)" };
  return (
    <span
      className="num grid size-7 shrink-0 place-items-center rounded-lg text-xs font-bold"
      style={{ backgroundColor: tone.bg, color: tone.fg }}
    >
      {rank}
    </span>
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

function Avatar({
  user,
  size,
}: {
  user: { avatar_url?: string | null; display_name?: string | null };
  size: number;
}) {
  const initial = (user.display_name ?? "?").trim().charAt(0).toUpperCase();
  if (user.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.avatar_url}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-card-2 text-[11px] font-semibold text-muted"
      style={{ width: size, height: size }}
    >
      {initial}
    </span>
  );
}
