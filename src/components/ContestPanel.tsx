"use client";

import { useCallback, useEffect, useState } from "react";
import { ActionButton, fmtClock, fmtDur, slotLetter, useNow } from "./arena-ui";
import { useGuildLive } from "./GuildLive";
import { Avatar, shortName } from "./guild-ui";
import { Card, Label } from "./ui";
import type { GuildContest } from "@/lib/arena-queries";

/*
  Custom guild contests: N random problems in a chosen rating band, a shared
  clock, a live board. Problems come from the mirrored CF problemset and are
  picked at start against the final field, so nobody has seen theirs.

  The board rides the same live pipe as the leaderboard: every detected AC
  fires a solve event, this panel refetches. Solved cells use the AC green
  because they ARE accepted verdicts — the one place the colour rule wants it.
*/

type ContestsState = {
  open: GuildContest | null;
  recent: GuildContest[];
  detectable: boolean;
};

const DURATIONS = [30, 45, 60, 90, 120, 180] as const;
const RATINGS = Array.from({ length: 28 }, (_, i) => 800 + i * 100);

export default function ContestPanel({ meId }: { meId: number }) {
  const { version } = useGuildLive();
  const [state, setState] = useState<ContestsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // create form
  const [count, setCount] = useState(4);
  const [lo, setLo] = useState(1000);
  const [hi, setHi] = useState(1600);
  const [minutes, setMinutes] = useState<number>(60);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/guild/contests");
      if (res.ok) setState((await res.json()) as ContestsState);
    } catch {
      // Keep the last good state; the next event or expiry retries.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/guild/contests");
        if (!res.ok || cancelled) return;
        setState((await res.json()) as ContestsState);
      } catch {
        // Transient failure — the next version bump retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  const act = useCallback(
    async (url: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!res.ok) setError(data?.error ?? "That didn't work.");
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const open = state?.open ?? null;
  const ticking = open?.status === "active";
  const now = useNow(ticking);
  const endsMs = open?.ends_at ? new Date(open.ends_at).getTime() : null;
  const remaining = endsMs === null ? null : endsMs - now;

  // One refetch scheduled for the moment the clock lands — the server's
  // sweep flips the status; this panel never declares a contest over itself.
  useEffect(() => {
    if (!ticking || endsMs === null) return;
    const wait = endsMs - Date.now() + 500;
    if (wait <= 0) return;
    const t = setTimeout(() => void load(), wait);
    return () => clearTimeout(t);
  }, [ticking, endsMs, load]);

  if (!state) {
    return (
      <Card>
        <Label>Guild contests</Label>
        <p className="text-sm text-muted">Loading…</p>
      </Card>
    );
  }

  const joined = open?.players.some((p) => p.user_id === meId) ?? false;
  const isCreator = open?.created_by === meId;

  return (
    <Card>
      <Label>Guild contests</Label>

      {!state.detectable && (
        <p className="mb-3 text-sm text-muted">
          Contests need the sync worker — solves are detected from the
          Codeforces mirror, and nothing is watching it right now.
        </p>
      )}

      {/* ---- nothing open: the creator form ---- */}
      {!open && (
        <div>
          <p className="text-sm text-muted">
            Random unseen Codeforces problems in a band you choose, one clock
            for everyone. Most solves wins; ties go to the faster total.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="rounded-xl border border-line bg-page px-2.5 py-2"
              aria-label="Number of problems"
            >
              {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>
                  {n} problems
                </option>
              ))}
            </select>
            <span className="text-muted">rated</span>
            <select
              value={lo}
              onChange={(e) => setLo(Number(e.target.value))}
              className="num rounded-xl border border-line bg-page px-2.5 py-2"
              aria-label="Minimum rating"
            >
              {RATINGS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <span className="text-muted">to</span>
            <select
              value={hi}
              onChange={(e) => setHi(Number(e.target.value))}
              className="num rounded-xl border border-line bg-page px-2.5 py-2"
              aria-label="Maximum rating"
            >
              {RATINGS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="rounded-xl border border-line bg-page px-2.5 py-2"
              aria-label="Duration"
            >
              {DURATIONS.map((m) => (
                <option key={m} value={m}>
                  {fmtDur(m * 60)}
                </option>
              ))}
            </select>
            <ActionButton
              disabled={busy || !state.detectable || lo > hi}
              onClick={() =>
                void act("/api/guild/contests", {
                  problem_count: count,
                  rating_min: lo,
                  rating_max: hi,
                  duration_s: minutes * 60,
                })
              }
            >
              Open a lobby
            </ActionButton>
          </div>
        </div>
      )}

      {/* ---- lobby ---- */}
      {open?.status === "lobby" && (
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm">
              <strong>{open.name}</strong>
              <span className="text-muted">
                {" "}
                · {open.problem_count} problems · {fmtDur(open.duration_s)} ·
                by {shortName({ display_name: open.creator_name })}
              </span>
            </p>
            <span className="text-xs text-muted">
              waiting for {shortName({ display_name: open.creator_name })} to
              start it
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {open.players.map((p) => (
              <span
                key={p.user_id}
                className="flex items-center gap-1.5 rounded-full border border-line bg-page py-1 pl-1 pr-2.5 text-xs"
              >
                <Avatar user={p} size={20} />
                {shortName(p)}
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {!joined && (
              <ActionButton
                disabled={busy}
                onClick={() =>
                  void act(`/api/guild/contests/${open.id}`, { action: "join" })
                }
              >
                Join
              </ActionButton>
            )}
            {joined && !isCreator && (
              <ActionButton
                tone="quiet"
                disabled={busy}
                onClick={() =>
                  void act(`/api/guild/contests/${open.id}`, { action: "leave" })
                }
              >
                Leave
              </ActionButton>
            )}
            {isCreator && (
              <>
                <ActionButton
                  disabled={busy}
                  onClick={() =>
                    void act(`/api/guild/contests/${open.id}`, {
                      action: "start",
                    })
                  }
                >
                  Start — reveal the problems
                </ActionButton>
                <ActionButton
                  tone="quiet"
                  disabled={busy}
                  onClick={() =>
                    void act(`/api/guild/contests/${open.id}`, {
                      action: "cancel",
                    })
                  }
                >
                  Cancel
                </ActionButton>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- active or finished: the board ---- */}
      {open?.status === "active" && (
        <ContestBoardView contest={open} meId={meId} remainingMs={remaining} />
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-wa">
          {error}
        </p>
      )}

      {state.recent.length > 0 && (
        <div className={`${open || state.recent.length ? "mt-5 border-t border-line pt-3" : ""}`}>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            Recent contests
          </div>
          <div className="space-y-4">
            {state.recent.slice(0, 2).map((c) => (
              <ContestBoardView key={c.id} contest={c} meId={meId} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function ContestBoardView({
  contest,
  meId,
  remainingMs,
}: {
  contest: GuildContest;
  meId: number;
  /** Present (and live) only while active. */
  remainingMs?: number | null;
}) {
  const startMs = contest.started_at
    ? new Date(contest.started_at).getTime()
    : null;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          <strong>{contest.name}</strong>
          <span className="text-muted"> · {fmtDur(contest.duration_s)}</span>
        </p>
        {remainingMs != null ? (
          <span className="num text-lg font-semibold" title="Time left">
            {fmtClock(remainingMs)}
          </span>
        ) : (
          <span className="text-xs text-muted">finished</span>
        )}
      </div>

      {/* The problems, lettered. Links go to Codeforces — solving happens
          there; this board only watches. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {contest.problems.map((p) => (
          <a
            key={p.problem_id}
            href={p.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-page px-2 py-1 text-xs transition-colors hover:border-accent/60"
            title={p.title}
          >
            <span className="num font-bold">{slotLetter(p.ordering)}</span>
            <span className="max-w-40 truncate">{p.title}</span>
            {p.rating && <span className="num text-muted">{p.rating}</span>}
          </a>
        ))}
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
              <th className="py-1.5 pr-2 font-semibold">#</th>
              <th className="py-1.5 pr-2 font-semibold">Player</th>
              {contest.problems.map((p) => (
                <th key={p.problem_id} className="num px-1.5 py-1.5 text-center font-semibold">
                  {slotLetter(p.ordering)}
                </th>
              ))}
              <th className="num px-1.5 py-1.5 text-right font-semibold">Solved</th>
            </tr>
          </thead>
          <tbody>
            {contest.players.map((player, i) => (
              <tr
                key={player.user_id}
                className={`border-t border-line ${
                  player.user_id === meId ? "bg-accent-soft/40" : ""
                }`}
              >
                <td className="num py-1.5 pr-2 text-muted">{i + 1}</td>
                <td className="py-1.5 pr-2">
                  <span className="flex items-center gap-1.5">
                    <Avatar user={player} size={20} />
                    <span className="truncate">{shortName(player)}</span>
                  </span>
                </td>
                {contest.problems.map((p) => {
                  const at = player.solved_at_ms[p.ordering];
                  return (
                    <td key={p.problem_id} className="num px-1.5 py-1.5 text-center">
                      {at && startMs ? (
                        // A genuine accepted verdict — the AC green is earned.
                        <span className="font-semibold text-ac">
                          {fmtClock(at - startMs)}
                        </span>
                      ) : (
                        <span className="text-muted/50">·</span>
                      )}
                    </td>
                  );
                })}
                <td className="num px-1.5 py-1.5 text-right font-semibold">
                  {player.solved}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
