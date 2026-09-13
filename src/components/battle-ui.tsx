"use client";

import { useEffect, useState } from "react";
import { fmtClock } from "./arena-ui";
import { Avatar, Medal, shortName } from "./guild-ui";
import LocalTime from "./LocalTime";
import { tierRating } from "@/lib/arena-rules";
import type { Battle, BattleMatch, BattlePlayer } from "@/lib/battle-queries";

/*
  Presentational pieces of the battle arena: the tier ladder everyone watches
  during a battle, and the match records everyone reads after it.

  Tier colours walk the 215°–330° band the brand owns (indigo → violet →
  magenta), the same range guild crests are drawn from — so a ladder of eight
  tiers reads as a climb without a single rung being verdict-green, -red or
  -amber. Above tier 8 the colour stops climbing; nothing else in the app is
  that high either.
*/

export function tierColor(tier: number): string {
  const hue = 215 + Math.min(Math.max(tier, 1) - 1, 7) * 16.4;
  return `oklch(0.62 0.19 ${hue})`;
}

export function TierPill({
  battle,
  tier,
  size = "sm",
}: {
  battle: Pick<Battle, "tier_base" | "tier_step">;
  tier: number;
  size?: "sm" | "lg";
}) {
  const color = tierColor(tier);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 font-semibold ${
        size === "lg" ? "py-1 text-sm" : "py-0.5 text-[11px]"
      }`}
      style={{
        borderColor: `color-mix(in oklab, ${color} 45%, transparent)`,
        color,
      }}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
      Tier {tier}
      <span className="num font-normal text-muted">{tierRating(battle, tier)}</span>
    </span>
  );
}

function PlayerChip({
  p,
  me,
  color,
  inMatch,
  flashUp,
  knocked,
  dim,
}: {
  p: BattlePlayer;
  me: boolean;
  color: string;
  inMatch: boolean;
  flashUp: boolean;
  knocked: boolean;
  dim: boolean;
}) {
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full border bg-card py-1 pl-1 pr-2.5 text-xs ${
        me ? "border-accent/60" : "border-line"
      } ${flashUp ? "tier-up" : ""} ${knocked ? "knocked-out" : ""} ${
        dim && !knocked ? "opacity-55 grayscale" : ""
      }`}
      style={{ "--tier": color } as React.CSSProperties}
      title={`${p.wins}W · ${p.losses}L · ${p.draws}D`}
    >
      <Avatar user={p} size={20} ring={me ? "var(--accent)" : undefined} />
      <span className="font-medium">{me ? "You" : shortName(p)}</span>
      {inMatch && (
        <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-dk">
          in match
        </span>
      )}
      {!inMatch && p.state === "queued" && (
        <span className="flex items-center gap-1 text-[10px] text-muted">
          <span
            className="live-dot size-1.5 rounded-full"
            style={{ backgroundColor: "var(--accent)" }}
          />
          queued
        </span>
      )}
    </span>
  );
}

/**
 * Who is where. One rung per tier, highest on top, the eliminated on a bench
 * at the bottom. A chip whose tier rose since the last render flashes in its
 * new rung's colour; one that just went out fades to the bench. No FLIP —
 * the rungs aren't a flat list, and a chip jumping between rungs is the
 * movement anyway.
 */
type Snapshot = {
  battle: Battle;
  seen: Map<number, { tier: number; state: string }>;
  up: Set<number>;
  out: Set<number>;
};

export function TierLadder({ battle, meId }: { battle: Battle; meId: number }) {
  // Derived from the previous render's battle, the React way (state set
  // during render when the input changes) rather than in an effect: who
  // climbed and who went out since the last refetch. The flash clears itself
  // a few seconds later.
  const [snap, setSnap] = useState<Snapshot | null>(null);
  if (snap === null || snap.battle !== battle) {
    const up = new Set<number>();
    const out = new Set<number>();
    if (snap) {
      for (const p of battle.players) {
        const was = snap.seen.get(p.user_id);
        if (!was) continue;
        if (p.tier > was.tier) up.add(p.user_id);
        if (p.state === "eliminated" && was.state !== "eliminated") out.add(p.user_id);
      }
    }
    setSnap({
      battle,
      seen: new Map(battle.players.map((p) => [p.user_id, { tier: p.tier, state: p.state }])),
      up,
      out,
    });
  }
  const flash = snap ?? { up: new Set<number>(), out: new Set<number>() };
  const flashing = flash.up.size > 0 || flash.out.size > 0;
  useEffect(() => {
    if (!flashing) return;
    const t = setTimeout(
      () => setSnap((s) => (s ? { ...s, up: new Set(), out: new Set() } : s)),
      3000,
    );
    return () => clearTimeout(t);
  }, [flashing, battle]);

  const alive = battle.players.filter((p) => p.state !== "eliminated");
  const out = battle.players.filter((p) => p.state === "eliminated");
  const top = Math.max(1, ...alive.map((p) => p.tier));
  const tiers = Array.from({ length: top }, (_, i) => top - i);
  const matched = new Set<number>();
  for (const m of battle.matches) {
    if (m.status === "active") {
      matched.add(m.a_id);
      matched.add(m.b_id);
    }
  }

  return (
    <div className="space-y-1.5">
      {tiers.map((t) => {
        const rung = alive.filter((p) => p.tier === t);
        const color = tierColor(t);
        return (
          <div
            key={t}
            className="flex items-stretch gap-3 rounded-xl border border-line bg-page p-2"
            style={{ borderLeft: `4px solid ${color}` }}
          >
            <div className="w-16 shrink-0 sm:w-20">
              <div
                className="text-[11px] font-semibold uppercase tracking-[0.12em]"
                style={{ color }}
              >
                Tier {t}
              </div>
              <div className="num text-xs text-muted">{tierRating(battle, t)}</div>
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {rung.length === 0 ? (
                <span className="text-xs text-muted/60">nobody here yet</span>
              ) : (
                rung.map((p) => (
                  <PlayerChip
                    key={p.user_id}
                    p={p}
                    me={p.user_id === meId}
                    color={color}
                    inMatch={matched.has(p.user_id)}
                    flashUp={flash.up.has(p.user_id)}
                    knocked={false}
                    dim={false}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
      {out.length > 0 && (
        <div className="flex items-stretch gap-3 rounded-xl border border-dashed border-line p-2">
          <div className="w-16 shrink-0 sm:w-20">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              Out
            </div>
            <div className="text-xs text-muted">spectating</div>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {out.map((p) => (
              <PlayerChip
                key={p.user_id}
                p={p}
                me={p.user_id === meId}
                color="var(--muted)"
                inMatch={false}
                flashUp={false}
                knocked={flash.out.has(p.user_id)}
                dim
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One line of a match's story, from the viewer's side of it. */
export function matchResult(m: BattleMatch, meId: number): string {
  const inIt = m.a_id === meId || m.b_id === meId;
  const name = (id: number) => (id === meId ? "you" : shortName({ display_name: id === m.a_id ? m.a_name : m.b_name }));
  if (m.status === "active") return "in play";
  if (m.finish_reason === "timeout" || m.winner_id === null) return "tie on the clock";
  const w = m.winner_id;
  const l = w === m.a_id ? m.b_id : m.a_id;
  const how = m.finish_reason === "forfeit" ? "by concession" : "first AC";
  if (inIt) return w === meId ? `you won, ${how}` : `${name(w)} won, ${how}`;
  return `${name(w)} beat ${name(l)}, ${how}`;
}

export function MatchRow({ m, meId }: { m: BattleMatch; meId: number }) {
  const inIt = m.a_id === meId || m.b_id === meId;
  const solveMs =
    m.finish_reason === "solve" && m.winning_submitted_at
      ? Date.parse(m.winning_submitted_at) - Date.parse(m.started_at)
      : null;
  return (
    <li className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm ${inIt ? "" : "text-muted"}`}>
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: tierColor(m.tier) }}
        title={`Tier ${m.tier}`}
      />
      <span className="font-medium text-ink">
        {m.a_id === meId ? "You" : shortName({ display_name: m.a_name })} vs{" "}
        {m.b_id === meId ? "you" : shortName({ display_name: m.b_name })}
      </span>
      <span>· {matchResult(m, meId)}</span>
      {solveMs !== null && (
        // A genuine accepted verdict — the AC green is earned.
        <span className="num text-xs text-ac">{fmtClock(solveMs)}</span>
      )}
      {m.problem_title ? (
        <a
          href={m.problem_url ?? "#"}
          target="_blank"
          rel="noreferrer"
          className="max-w-56 truncate text-ink underline-offset-2 hover:underline"
          title={m.problem_title}
        >
          {m.problem_title}
        </a>
      ) : (
        <span className="text-xs italic text-muted/70">problem hidden until it ends</span>
      )}
      {m.problem_rating && <span className="num text-xs">{m.problem_rating}</span>}
      <span className="num ml-auto text-[11px] text-muted/80">
        <LocalTime iso={m.started_at} mode="time" />
      </span>
    </li>
  );
}

/** The podium: the top three of the final ladder. */
export function Podium({ battle, meId }: { battle: Battle; meId: number }) {
  const top = battle.players.slice(0, 3);
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {top.map((p, i) => (
        <div
          key={p.user_id}
          className={`flex items-center gap-3 rounded-xl border p-3 ${
            i === 0 ? "border-transparent" : "border-line bg-page"
          }`}
          style={
            i === 0
              ? {
                  backgroundImage:
                    "linear-gradient(120deg, color-mix(in oklab, var(--streak-a) 16%, transparent), color-mix(in oklab, var(--streak-b) 12%, transparent))",
                  boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--streak-b) 40%, transparent)",
                }
              : undefined
          }
        >
          <Medal rank={i + 1} size={32} />
          <Avatar user={p} size={36} ring={p.user_id === meId ? "var(--accent)" : undefined} />
          <div className="min-w-0">
            <div className="truncate font-display text-[15px] font-semibold">
              {p.user_id === meId ? "You" : shortName(p)}
              {i === 0 && <span className="ml-1.5 text-xs font-normal text-muted">champion</span>}
            </div>
            <div className="num text-xs text-muted">
              tier {p.tier} · {p.wins}W {p.losses}L {p.draws}D
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Every player's record: who they beat, who beat them, on what. */
export function RecordList({ battle, meId }: { battle: Battle; meId: number }) {
  return (
    <ol className="space-y-1.5">
      {battle.players.map((p, i) => {
        const mine = battle.matches.filter((m) => m.a_id === p.user_id || m.b_id === p.user_id);
        return (
          <li key={p.user_id}>
            <details className="group rounded-xl border border-line bg-page" open={p.user_id === meId}>
              <summary className="flex cursor-pointer list-none items-center gap-2.5 p-2.5 text-sm [&::-webkit-details-marker]:hidden">
                <Medal rank={i + 1} size={24} />
                <Avatar user={p} size={24} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {p.user_id === meId ? "You" : shortName(p)}
                  <span className="ml-2 text-xs font-normal text-muted">
                    {p.state === "eliminated" ? "out at" : "finished at"} tier {p.tier}
                  </span>
                </span>
                <span className="num shrink-0 text-xs text-muted">
                  {p.wins}W {p.losses}L {p.draws}D
                </span>
                <span className="text-muted transition-transform group-open:rotate-90">›</span>
              </summary>
              <ul className="space-y-1 border-t border-line px-3 py-2">
                {mine.length === 0 ? (
                  <li className="text-xs text-muted">Never got a match.</li>
                ) : (
                  mine.map((m) => <MatchRow key={m.id} m={m} meId={p.user_id === meId ? meId : -1} />)
                )}
              </ul>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
