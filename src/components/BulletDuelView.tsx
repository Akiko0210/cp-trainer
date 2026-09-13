"use client";

import { useMemo } from "react";
import { ActionButton, BigClock, fmtClock } from "./arena-ui";
import { useLiveHold } from "./GuildLive";
import { Avatar, shortName } from "./guild-ui";
import {
  AlertsToggle,
  bulletFeed,
  LiveFeed,
  useArenaAlerts,
  useFeedAlerts,
} from "./live-feed";
import type { Duel } from "@/lib/arena-queries";

/*
  A bullet duel in play: the clock, the score, the problem on the table, the
  rounds already taken, and the live report underneath. Everything here is
  read from the duel the panel refetched; the only client-side state is which
  score just changed (so it can pop) — the server's rounds are the truth.
*/

export default function BulletDuelView({
  duel,
  meId,
  remainingMs,
  live,
  busy,
  onForfeit,
  push,
}: {
  duel: Duel;
  meId: number;
  remainingMs: number;
  live: boolean;
  busy: boolean;
  onForfeit: () => void;
  push: (text: string) => void;
}) {
  // The whole point of the mode is finding out in time; a hidden tab must
  // not park the stream while the race is on.
  useLiveHold(duel.status === "active");

  const iAmChallenger = duel.challenger_id === meId;
  const mine = iAmChallenger ? duel.challenger_points : duel.opponent_points;
  const theirs = iAmChallenger ? duel.opponent_points : duel.challenger_points;
  const rivalName = shortName({
    display_name: iAmChallenger ? duel.opponent_name : duel.challenger_name,
  });
  const rounds = duel.rounds ?? [];
  const current = rounds.find((r) => r.closed_at === null) ?? null;
  const closed = rounds.filter((r) => r.closed_at !== null).reverse();

  const items = useMemo(() => bulletFeed(duel, meId), [duel, meId]);
  const alerts = useArenaAlerts();
  useFeedAlerts(items, { push, notify: alerts.enabled, title: "Bullet duel" });

  // A score pops when it changes: the number is keyed by its value, so a
  // change remounts it and replays the animation. (It also pops once when
  // the view first appears — the game beginning is worth a flourish.)
  const pop = "score-pop";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          Bullet vs <strong>{rivalName}</strong>
          <span className="text-muted">
            {" "}
            · ladder from {duel.bullet_start_rating}, +{duel.bullet_step} a round
          </span>
        </p>
        <BigClock ms={remainingMs} />
      </div>

      {/* ---- the score ---- */}
      <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-(--radius-card) border border-line bg-page p-3 text-center">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            You
          </div>
          <div key={`m${mine}`} className={`num font-display mt-1 text-[32px] font-semibold leading-none ${pop}`}>
            {mine}
          </div>
        </div>
        <div className="font-display text-lg text-muted">—</div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            {rivalName}
          </div>
          <div key={`t${theirs}`} className={`num font-display mt-1 text-[32px] font-semibold leading-none ${pop}`}>
            {theirs}
          </div>
        </div>
      </div>

      {/* ---- the problem on the table ---- */}
      {current ? (
        <a
          key={current.round_no}
          href={current.problem_url}
          target="_blank"
          rel="noreferrer"
          className="round-open mt-3 block rounded-xl border border-line bg-page p-4 transition-colors hover:border-accent/60"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-dk">
              Round {current.round_no}
            </span>
            <span className="num text-xs font-semibold text-muted">
              {current.points} pts
            </span>
          </div>
          <div className="mt-1 text-[15px] font-semibold">{current.problem_title}</div>
          <div className="num mt-1 text-xs text-muted">
            {current.problem_rating ? `rated ${current.problem_rating} · ` : ""}
            opens on Codeforces
          </div>
        </a>
      ) : (
        <p className="mt-3 rounded-xl border border-dashed border-line p-4 text-sm text-muted">
          Picking the next problem…
        </p>
      )}

      {/* ---- rounds taken ---- */}
      {closed.length > 0 && (
        <ol className="mt-3 space-y-1">
          {closed.map((r) => (
            <li key={r.round_no} className="flex items-center gap-2 text-sm">
              <span className="num w-5 shrink-0 text-muted">{r.round_no}</span>
              <span className="min-w-0 flex-1 truncate">{r.problem_title}</span>
              {r.winner_id === null ? (
                <span className="text-xs text-muted">unwon</span>
              ) : (
                <>
                  <Avatar
                    user={{
                      display_name:
                        r.winner_id === meId ? "You" : rivalName,
                    }}
                    size={16}
                  />
                  <span className="num shrink-0 text-xs font-semibold">
                    {r.winner_id === meId ? "you" : rivalName} +{r.points}
                  </span>
                  {r.won_at && (
                    // A genuine accepted verdict — the AC green is earned.
                    <span className="num shrink-0 text-xs text-ac">
                      {fmtClock(Date.parse(r.won_at) - Date.parse(r.opened_at))}
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          Submit on Codeforces as usual — rounds are settled on the judge&apos;s
          clock, checked every few seconds. Take one and the next opens at once.
        </p>
        <div className="flex items-center gap-2">
          <AlertsToggle {...alerts} />
          <ActionButton tone="quiet" disabled={busy} onClick={onForfeit}>
            Concede
          </ActionButton>
        </div>
      </div>

      <div className="mt-3">
        <LiveFeed items={items} live={live} />
      </div>
    </div>
  );
}
