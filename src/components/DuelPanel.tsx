"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ActionButton,
  fmtClock,
  fmtDur,
  LoadingCard,
  useAct,
  useNow,
} from "./arena-ui";
import BulletDuelView from "./BulletDuelView";
import { useGuildLive } from "./GuildLive";
import { shortName } from "./guild-ui";
import Select from "./Select";
import { Toasts, useToasts } from "./Toast";
import { Card, Label } from "./ui";
import type { Duel } from "@/lib/arena-queries";
import {
  BULLET_DURATIONS_S,
  BULLET_START,
  BULLET_STEPS,
  type DuelMode,
} from "@/lib/arena-rules";

/*
  Duels: challenge a guildmate. Classic — both get the same unseen problem,
  first accepted solution wins. Bullet — a clock and a ladder of problems,
  each round worth its problem's rating, most points at the bell. No rating,
  no stakes — the loser's mastery scores don't know it happened.

  State lives on the server; this panel only renders it and refetches when the
  live stream says a duel row (or a bullet round) moved. The countdowns are
  the one client-side thing, and when one runs out the panel refetches rather
  than declaring anything itself — the server's sweep is the referee.
*/

type Member = {
  user_id: number;
  display_name: string | null;
  github_login: string | null;
  avatar_url: string | null;
  cf_handle: string;
  cf_rating: number | null;
};

type DuelState = {
  duel: Duel | null;
  recent: Duel[];
  members: Member[];
  detectable: boolean;
};

const START_RATINGS = Array.from(
  { length: (BULLET_START.max - BULLET_START.min) / 100 + 1 },
  (_, i) => BULLET_START.min + i * 100,
);

export default function DuelPanel({ meId }: { meId: number }) {
  const { version, live } = useGuildLive();
  const [state, setState] = useState<DuelState | null>(null);
  const [opponent, setOpponent] = useState<string>("");
  const [mode, setMode] = useState<DuelMode>("classic");
  const [minutes, setMinutes] = useState("10");
  const [start, setStart] = useState("1000");
  const [step, setStep] = useState("100");
  // A finished duel stays on screen until dismissed; remember which one was
  // waved away so it doesn't reappear on the next refetch.
  const [dismissedId, setDismissedId] = useState<number | null>(null);
  const { toasts, push } = useToasts();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/guild/duels");
      if (res.ok) setState((await res.json()) as DuelState);
    } catch {
      // Transient fetch failure: keep showing what we had; the next version
      // bump or countdown expiry retries.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/guild/duels");
        if (!res.ok || cancelled) return;
        setState((await res.json()) as DuelState);
      } catch {
        // Transient failure — the next version bump retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  const { act, busy, error } = useAct(load);

  const duel =
    state?.duel && state.duel.id !== dismissedId ? state.duel : null;
  const ticking = duel?.status === "pending" || duel?.status === "active";
  const now = useNow(ticking);

  /*
    When the countdown crosses zero the truth changes server-side (the sweep
    marks it expired or timed out) but nothing pushes for an expiry — so
    schedule one refetch for the moment it lands.
  */
  const deadlineMs = duel
    ? new Date(
        duel.status === "pending" ? duel.expires_at : (duel.deadline_at ?? 0),
      ).getTime()
    : null;
  const remaining = deadlineMs === null ? null : deadlineMs - now;
  useEffect(() => {
    if (!ticking || deadlineMs === null) return;
    const wait = deadlineMs - Date.now() + 500;
    if (wait <= 0) return;
    const t = setTimeout(() => void load(), wait);
    return () => clearTimeout(t);
  }, [ticking, deadlineMs, load]);

  if (!state) return <LoadingCard />;

  const iAmChallenger = duel?.challenger_id === meId;
  const rival = duel
    ? iAmChallenger
      ? { name: duel.opponent_name }
      : { name: duel.challenger_name }
    : null;
  const myPoints = duel
    ? iAmChallenger
      ? duel.challenger_points
      : duel.opponent_points
    : 0;
  const theirPoints = duel
    ? iAmChallenger
      ? duel.opponent_points
      : duel.challenger_points
    : 0;

  return (
    <Card>
      {!state.detectable && (
        <p className="mb-3 text-sm text-muted">
          Duels need the sync worker — solves are detected from the Codeforces
          mirror, and nothing is watching it right now.
        </p>
      )}

      {/* ---- no duel: pick a victim, pick a mode ---- */}
      {!duel && (
        <div>
          <div
            role="tablist"
            aria-label="Duel mode"
            className="mb-3 inline-flex rounded-xl bg-card-2 p-1"
          >
            {(
              [
                ["classic", "Classic", "one problem, first AC"],
                ["bullet", "Bullet", "a clock, a ladder, points"],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                title={hint}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === value
                    ? "bg-card text-ink shadow-sm"
                    : "text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={opponent}
              onChange={setOpponent}
              placeholder="Choose an opponent…"
              ariaLabel="Choose an opponent"
              className="min-w-52 flex-1"
              options={state.members.map((m) => ({
                value: String(m.user_id),
                label: m.display_name ?? m.github_login ?? m.cf_handle,
                hint: m.cf_rating ? String(m.cf_rating) : undefined,
              }))}
            />
            {mode === "bullet" && (
              <>
                <Select
                  value={minutes}
                  onChange={setMinutes}
                  ariaLabel="Bullet clock"
                  className="w-28"
                  options={BULLET_DURATIONS_S.map((s) => ({
                    value: String(s / 60),
                    label: `${s / 60} min`,
                  }))}
                />
                <Select
                  value={start}
                  onChange={setStart}
                  ariaLabel="Ladder starts at"
                  className="w-32"
                  options={START_RATINGS.map((r) => ({
                    value: String(r),
                    label: `from ${r}`,
                  }))}
                />
                <Select
                  value={step}
                  onChange={setStep}
                  ariaLabel="Ladder step per round"
                  className="w-32"
                  options={BULLET_STEPS.map((s) => ({
                    value: String(s),
                    label: `+${s} a round`,
                  }))}
                />
              </>
            )}
            <ActionButton
              disabled={busy || !opponent || !state.detectable}
              onClick={() =>
                void act("/api/guild/duels", {
                  opponent_id: Number(opponent),
                  mode,
                  duration_s: Number(minutes) * 60,
                  start_rating: Number(start),
                  step: Number(step),
                })
              }
            >
              {mode === "bullet" ? "Challenge to bullet" : "Challenge"}
            </ActionButton>
          </div>
          {mode === "bullet" && (
            <p className="mt-2 text-xs text-muted">
              Same problem for both; first AC takes the round and its rating in
              points, and the next, harder one opens at once. Most points at
              the bell wins.
            </p>
          )}
          {state.members.length === 0 && (
            <p className="mt-2 text-xs text-muted">
              Nobody else with a linked handle yet — duels need two.
            </p>
          )}
        </div>
      )}

      {/* ---- pending ---- */}
      {duel?.status === "pending" && (
        <div>
          <p className="text-sm">
            {iAmChallenger ? (
              <>
                Challenge sent to <strong>{rival?.name}</strong>. It expires in{" "}
                <span className="num">{fmtClock(remaining ?? 0)}</span>.
              </>
            ) : (
              <>
                <strong>{rival?.name}</strong> challenges you!{" "}
                {duel.mode === "bullet"
                  ? "A bullet ladder — first AC takes each round, most points at the bell."
                  : "Same problem for both, first AC wins."}{" "}
                Expires in <span className="num">{fmtClock(remaining ?? 0)}</span>.
              </>
            )}
          </p>
          {duel.mode === "bullet" && (
            <p className="mt-1 text-xs text-muted">
              Bullet · {fmtDur(duel.duration_s)} · from {duel.bullet_start_rating},
              +{duel.bullet_step} a round
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {iAmChallenger ? (
              <ActionButton
                tone="quiet"
                disabled={busy}
                onClick={() =>
                  void act(`/api/guild/duels/${duel.id}`, { action: "cancel" })
                }
              >
                Withdraw
              </ActionButton>
            ) : (
              <>
                <ActionButton
                  disabled={busy}
                  onClick={() =>
                    void act(`/api/guild/duels/${duel.id}`, { action: "accept" })
                  }
                >
                  Accept — go!
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
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- active: the race ---- */}
      {duel?.status === "active" && duel.mode === "bullet" && (
        <BulletDuelView
          duel={duel}
          meId={meId}
          remainingMs={remaining ?? 0}
          live={live}
          busy={busy}
          push={push}
          onForfeit={() =>
            void act(`/api/guild/duels/${duel.id}`, { action: "forfeit" })
          }
        />
      )}
      {duel?.status === "active" && duel.mode === "classic" && (
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm">
              You vs <strong>{rival?.name}</strong> — first AC wins.
            </p>
            <span className="num text-lg font-semibold" title="Time left">
              {fmtClock(remaining ?? 0)}
            </span>
          </div>
          <a
            href={duel.problem_url ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="mt-3 block rounded-xl border border-line bg-page p-4 transition-colors hover:border-accent/60"
          >
            <div className="text-[15px] font-semibold">
              {duel.problem_title ?? "The problem"}
            </div>
            <div className="num mt-1 text-xs text-muted">
              {duel.problem_rating ? `rated ${duel.problem_rating} · ` : ""}
              opens on Codeforces
            </div>
          </a>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              Submit on Codeforces as usual — the winner is picked from the
              judge&apos;s own clock, checked every few seconds.
            </p>
            <ActionButton
              tone="quiet"
              disabled={busy}
              onClick={() =>
                void act(`/api/guild/duels/${duel.id}`, { action: "forfeit" })
              }
            >
              Concede
            </ActionButton>
          </div>
        </div>
      )}

      {/* ---- just finished ---- */}
      {duel?.status === "finished" && (
        <div>
          <p className="text-sm">
            {duel.mode === "bullet" ? (
              duel.finish_reason === "forfeit" ? (
                duel.winner_id === meId ? (
                  <>
                    <strong>You won</strong> — {rival?.name} conceded at{" "}
                    <span className="num">
                      {myPoints}–{theirPoints}
                    </span>
                    .
                  </>
                ) : (
                  <>
                    <strong>{duel.winner_name}</strong> takes it — you conceded at{" "}
                    <span className="num">
                      {myPoints}–{theirPoints}
                    </span>
                    .
                  </>
                )
              ) : duel.winner_id === null ? (
                <>
                  Time! A draw,{" "}
                  <span className="num">
                    {myPoints}–{theirPoints}
                  </span>{" "}
                  over {duel.rounds_opened} round{duel.rounds_opened === 1 ? "" : "s"}.
                  Honourably.
                </>
              ) : duel.winner_id === meId ? (
                <>
                  Time! <strong>You won</strong>{" "}
                  <span className="num">
                    {myPoints}–{theirPoints}
                  </span>{" "}
                  over {duel.rounds_opened} round{duel.rounds_opened === 1 ? "" : "s"}.
                </>
              ) : (
                <>
                  Time! <strong>{duel.winner_name}</strong> wins{" "}
                  <span className="num">
                    {theirPoints}–{myPoints}
                  </span>{" "}
                  over {duel.rounds_opened} round{duel.rounds_opened === 1 ? "" : "s"}.
                  Rematch?
                </>
              )
            ) : duel.finish_reason === "timeout" ? (
              <>
                Time ran out — nobody cracked{" "}
                <strong>{duel.problem_title}</strong>. A draw, honourably.
              </>
            ) : duel.winner_id === meId ? (
              <>
                <strong>You won</strong>
                {duel.finish_reason === "forfeit"
                  ? ` — ${rival?.name} conceded.`
                  : duel.winning_submitted_at && duel.started_at
                    ? ` — AC in ${fmtClock(
                        new Date(duel.winning_submitted_at).getTime() -
                          new Date(duel.started_at).getTime(),
                      )}.`
                    : "."}
              </>
            ) : (
              <>
                <strong>{duel.winner_name}</strong> takes it
                {duel.finish_reason === "forfeit"
                  ? " — you conceded."
                  : duel.winning_submitted_at && duel.started_at
                    ? ` — AC in ${fmtClock(
                        new Date(duel.winning_submitted_at).getTime() -
                          new Date(duel.started_at).getTime(),
                      )}. Rematch?`
                    : "."}
              </>
            )}
          </p>
          <div className="mt-3">
            <ActionButton tone="quiet" onClick={() => setDismissedId(duel.id)}>
              Done
            </ActionButton>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-wa">
          {error}
        </p>
      )}

      {/* ---- recent results ---- */}
      {state.recent.length > 0 && (
        <div className="mt-5 border-t border-line pt-3">
          <Label>Recent duels</Label>
          <ul className="space-y-1.5">
            {state.recent.slice(0, 5).map((d) => (
              <li key={d.id} className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 truncate">
                  {d.winner_id === null ? (
                    <>
                      {shortName({ display_name: d.challenger_name })} ·{" "}
                      {shortName({ display_name: d.opponent_name })} — draw
                    </>
                  ) : (
                    <>
                      <strong>
                        {shortName({ display_name: d.winner_name })}
                      </strong>{" "}
                      beat{" "}
                      {shortName({
                        display_name:
                          d.winner_id === d.challenger_id
                            ? d.opponent_name
                            : d.challenger_name,
                      })}
                      {d.finish_reason === "forfeit" && " by concession"}
                    </>
                  )}
                  {d.mode === "bullet" && (
                    <span className="num text-muted">
                      {" "}
                      · bullet{" "}
                      {d.winner_id === d.opponent_id
                        ? `${d.opponent_points}–${d.challenger_points}`
                        : `${d.challenger_points}–${d.opponent_points}`}
                    </span>
                  )}
                </span>
                {d.mode === "classic" &&
                  d.finish_reason === "solve" &&
                  d.winning_submitted_at &&
                  d.started_at && (
                    <span className="num shrink-0 text-xs text-muted">
                      {fmtClock(
                        new Date(d.winning_submitted_at).getTime() -
                          new Date(d.started_at).getTime(),
                      )}
                    </span>
                  )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Toasts items={toasts} />
    </Card>
  );
}
