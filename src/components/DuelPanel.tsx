"use client";

import { useCallback, useEffect, useState } from "react";
import { ActionButton, fmtClock, useNow } from "./arena-ui";
import { useGuildLive } from "./GuildLive";
import { shortName } from "./guild-ui";
import { Card, Label } from "./ui";
import type { Duel } from "@/lib/arena-queries";

/*
  Duels: challenge a guildmate, both get the same unseen problem, first
  accepted solution wins. No rating, no stakes — the loser's mastery scores
  don't know it happened.

  State lives on the server; this panel only renders it and refetches when the
  live stream says a duel row moved (the `duel` events in StandingsEvent).
  The countdowns are the one client-side thing, and when one runs out the
  panel refetches rather than declaring anything itself — the server's sweep
  is the referee.
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

export default function DuelPanel({ meId }: { meId: number }) {
  const { version } = useGuildLive();
  const [state, setState] = useState<DuelState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opponent, setOpponent] = useState<string>("");
  // A finished duel stays on screen until dismissed; remember which one was
  // waved away so it doesn't reappear on the next refetch.
  const [dismissedId, setDismissedId] = useState<number | null>(null);

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

  if (!state) {
    return (
      <Card>
        <Label>Duels</Label>
        <p className="text-sm text-muted">Loading…</p>
      </Card>
    );
  }

  const iAmChallenger = duel?.challenger_id === meId;
  const rival = duel
    ? iAmChallenger
      ? { name: duel.opponent_name }
      : { name: duel.challenger_name }
    : null;

  return (
    <Card>
      <Label>Duels</Label>

      {!state.detectable && (
        <p className="mb-3 text-sm text-muted">
          Duels need the sync worker — solves are detected from the Codeforces
          mirror, and nothing is watching it right now.
        </p>
      )}

      {/* ---- no duel: pick a victim ---- */}
      {!duel && (
        <div>
          <p className="text-sm text-muted">
            Same unseen problem for both of you, near your average rating.
            First accepted solution wins. Nothing but pride at stake.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={opponent}
              onChange={(e) => setOpponent(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-line bg-page px-3 py-2.5 text-sm"
              aria-label="Choose an opponent"
            >
              <option value="">Choose an opponent…</option>
              {state.members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.display_name ?? m.github_login ?? m.cf_handle}
                  {m.cf_rating ? ` · ${m.cf_rating}` : ""}
                </option>
              ))}
            </select>
            <ActionButton
              disabled={busy || !opponent || !state.detectable}
              onClick={() =>
                void act("/api/guild/duels", { opponent_id: Number(opponent) })
              }
            >
              Challenge
            </ActionButton>
          </div>
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
                <strong>{rival?.name}</strong> challenges you! Same problem for
                both, first AC wins. Expires in{" "}
                <span className="num">{fmtClock(remaining ?? 0)}</span>.
              </>
            )}
          </p>
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
      {duel?.status === "active" && (
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
            {duel.finish_reason === "timeout" ? (
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
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            Recent duels
          </div>
          <ul className="space-y-1.5">
            {state.recent.slice(0, 5).map((d) => (
              <li key={d.id} className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 truncate">
                  {d.finish_reason === "timeout" ? (
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
                </span>
                {d.finish_reason === "solve" &&
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
    </Card>
  );
}
