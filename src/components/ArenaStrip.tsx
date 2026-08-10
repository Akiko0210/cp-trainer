"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ActionButton, fmtClock, useNow } from "./arena-ui";
import { useGuildLive } from "./GuildLive";
import type { Duel, GuildContest } from "@/lib/arena-queries";

/*
  The arena's one-line presence on the guild page.

  The full panels live on /guild/duels and /guild/contests; this strip exists
  because the two
  things that can't wait for a navigation are an incoming challenge (five
  minutes and counting) and a race already running. Everything else is a
  quiet link. When nothing is happening it stays one sentence tall — the
  guild page's subject is the standings, not the furniture.
*/

type StripState = {
  duel: Duel | null;
  contest: GuildContest | null;
};

export default function ArenaStrip({ meId }: { meId: number }) {
  const router = useRouter();
  const { version } = useGuildLive();
  const [state, setState] = useState<StripState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [duelsRes, contestsRes] = await Promise.all([
        fetch("/api/guild/duels"),
        fetch("/api/guild/contests"),
      ]);
      if (!duelsRes.ok || !contestsRes.ok) return;
      const duels = (await duelsRes.json()) as { duel: Duel | null };
      const contests = (await contestsRes.json()) as {
        open: GuildContest | null;
      };
      setState({ duel: duels.duel, contest: contests.open });
    } catch {
      // Transient — the next version bump retries.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load, version]);

  const act = useCallback(
    async (url: string, body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        // Accepting means the race is already running — put the problem in
        // front of them instead of leaving a countdown ticking in a strip.
        if (res.ok && body.action === "accept") {
          router.push("/guild/duels");
          return;
        }
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load, router],
  );

  // Only the viewer's own open duel matters here; a finished one is the
  // arena page's news, not the guild page's.
  const duel =
    state?.duel && (state.duel.status === "pending" || state.duel.status === "active")
      ? state.duel
      : null;
  const contest = state?.contest ?? null;

  const ticking = duel !== null;
  const now = useNow(ticking);
  const deadline = duel
    ? new Date(
        duel.status === "pending" ? duel.expires_at : (duel.deadline_at ?? 0),
      ).getTime()
    : null;
  const remaining = deadline === null ? null : deadline - now;

  // A countdown that hits zero asks the server what's true now.
  useEffect(() => {
    if (!ticking || deadline === null) return;
    const wait = deadline - Date.now() + 500;
    if (wait <= 0) return;
    const t = setTimeout(() => void load(), wait);
    return () => clearTimeout(t);
  }, [ticking, deadline, load]);

  const incoming = duel?.status === "pending" && duel.opponent_id === meId;

  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-(--radius-card) border border-line bg-card px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
          Arena
        </span>

        {/* the one state that can't wait: someone is asking */}
        {incoming && duel && (
          <>
            <span>
              <strong>{duel.challenger_name}</strong> challenges you to a duel
              — <span className="num">{fmtClock(remaining ?? 0)}</span> to
              answer.
            </span>
            <span className="flex gap-2">
              <ActionButton
                disabled={busy}
                onClick={() =>
                  void act(`/api/guild/duels/${duel.id}`, { action: "accept" })
                }
              >
                Accept
              </ActionButton>
              <ActionButton
                tone="quiet"
                disabled={busy}
                onClick={() =>
                  void act(`/api/guild/duels/${duel.id}`, { action: "decline" })
                }
              >
                Decline
              </ActionButton>
            </span>
          </>
        )}

        {duel && !incoming && duel.status === "pending" && (
          <span>
            Challenge sent to <strong>{duel.opponent_name}</strong> — expires
            in <span className="num">{fmtClock(remaining ?? 0)}</span>.
          </span>
        )}

        {duel?.status === "active" && (
          <span>
            Duelling{" "}
            <strong>
              {duel.challenger_id === meId
                ? duel.opponent_name
                : duel.challenger_name}
            </strong>{" "}
            on <em>{duel.problem_title}</em> —{" "}
            <span className="num">{fmtClock(remaining ?? 0)}</span> left.
          </span>
        )}

        {!duel && contest && (
          <span>
            <strong>{contest.name}</strong>{" "}
            {contest.status === "lobby" ? (
              <>
                is open — {contest.players.length} in, waiting to start.
              </>
            ) : (
              <>is running.</>
            )}
          </span>
        )}

        {!duel && !contest && state && (
          <span className="text-muted">
            Challenge a guildmate to a duel, or throw a custom contest.
          </span>
        )}

        {!state && <span className="text-muted">…</span>}
      </div>

      {/*
        The link goes where the news is. With something live there is exactly
        one place worth being, so send them straight there rather than making
        them pick a tab they already know the answer to.
      */}
      <div className="flex shrink-0 items-center gap-3 text-sm font-medium">
        {duel ? (
          <Link
            href="/guild/duels"
            className="text-accent transition-opacity hover:opacity-80"
          >
            Go to the duel →
          </Link>
        ) : contest ? (
          <Link
            href="/guild/contests"
            className="text-accent transition-opacity hover:opacity-80"
          >
            Go to the contest →
          </Link>
        ) : (
          <>
            <Link
              href="/guild/duels"
              className="text-accent transition-opacity hover:opacity-80"
            >
              Duels →
            </Link>
            <Link
              href="/guild/contests"
              className="text-accent transition-opacity hover:opacity-80"
            >
              Contests →
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
