"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionButton, BigClock, fmtDur, LoadingCard, useAct, useNow, useRaceFloor } from "./arena-ui";
import { Podium, RecordList, TierLadder, TierPill, MatchRow } from "./battle-ui";
import { StatusPill } from "./BattlesPanel";
import { useGuildLive, useLiveHold } from "./GuildLive";
import { Avatar, shortName } from "./guild-ui";
import {
  AlertsToggle,
  battleFeed,
  LiveFeed,
  useArenaAlerts,
  useFeedAlerts,
} from "./live-feed";
import LocalTime from "./LocalTime";
import { Toasts, useToasts } from "./Toast";
import { Card, Empty, Label } from "./ui";
import type { Battle, BattleMatch, BattlePlayer } from "@/lib/battle-queries";

/*
  The room a battle is played in. One page, four faces: the lobby before the
  start, the live arena (your match, the queue, the ladder, the feed), the
  closing stretch, and the final record.

  Like every arena panel it renders server state and refetches when the live
  stream says something in the battle moved; the only client-side clocks are
  countdowns, and when one lands the panel refetches rather than deciding
  anything itself. A participant's tab holds the stream open while hidden
  (useLiveHold) — the whole point is being told the moment a match is ready.
*/

type RoomState = { battle: Battle; detectable: boolean };

export default function BattleRoom({ id, meId }: { id: number; meId: number }) {
  const { version, live } = useGuildLive();
  const [state, setState] = useState<RoomState | null>(null);
  const [gone, setGone] = useState(false);
  const { toasts, push } = useToasts();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/guild/battles/${id}`);
      if (res.status === 404) {
        setGone(true);
        return;
      }
      if (res.ok) setState((await res.json()) as RoomState);
    } catch {
      // Keep what we had; the next event or clock retries.
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/guild/battles/${id}`);
        if (cancelled) return;
        if (res.status === 404) {
          setGone(true);
          return;
        }
        if (res.ok) setState((await res.json()) as RoomState);
      } catch {
        // Transient failure — the next version bump retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version, id]);

  const { act, busy, error } = useAct(load);

  if (gone) {
    return (
      <Empty
        title="No such battle"
        action={
          <Link href="/guild/battles" className="text-sm text-accent-dk hover:underline">
            Back to the arena
          </Link>
        }
      >
        It isn&apos;t in your guild, or it never existed.
      </Empty>
    );
  }
  if (!state) return <LoadingCard />;

  return (
    <>
      <Room
        battle={state.battle}
        detectable={state.detectable}
        meId={meId}
        live={live}
        busy={busy}
        error={error}
        push={push}
        load={load}
        action={(a) => void act(`/api/guild/battles/${state.battle.id}`, { action: a })}
      />
      <Toasts items={toasts} />
    </>
  );
}

function Room({
  battle,
  detectable,
  meId,
  live,
  busy,
  error,
  push,
  load,
  action,
}: {
  battle: Battle;
  detectable: boolean;
  meId: number;
  live: boolean;
  busy: boolean;
  error: string | null;
  push: (text: string) => void;
  load: () => Promise<void>;
  action: (a: string) => void;
}) {
  const me = battle.players.find((p) => p.user_id === meId) ?? null;
  const myMatch =
    me?.current_match_id != null
      ? (battle.matches.find((m) => m.id === me.current_match_id) ?? null)
      : null;
  const running =
    battle.status === "scheduled" || battle.status === "active" || battle.status === "closing";
  const now = useNow(running);

  const racing =
    !!me &&
    battle.status !== "finished" &&
    (me.state === "matched" || (me.state === "queued" && battle.status === "active"));
  useLiveHold(racing);
  useRaceFloor(racing, load);

  const items = useMemo(() => battleFeed(battle, meId), [battle, meId]);
  const alerts = useArenaAlerts();
  useFeedAlerts(items, { push, notify: alerts.enabled, title: battle.name });

  // One refetch for each moment a clock lands: the start, the bell, my
  // match's deadline. The server's sweep is what flips the state.
  const startsMs = Date.parse(battle.starts_at);
  const endsMs = Date.parse(battle.ends_at);
  const deadlineMs = myMatch ? Date.parse(myMatch.deadline_at) : null;
  useEffect(() => {
    if (!running) return;
    const marks = [
      battle.status === "scheduled" ? startsMs : null,
      battle.status === "active" ? endsMs : null,
      deadlineMs,
    ].filter((t): t is number => t !== null);
    const timers = marks
      .map((t) => t - Date.now() + 500)
      .filter((wait) => wait > 0)
      .map((wait) => setTimeout(() => void load(), wait));
    return () => timers.forEach(clearTimeout);
  }, [running, battle.status, startsMs, endsMs, deadlineMs, load]);

  const isHost = battle.host_id === meId;

  return (
    <div className="space-y-4">
      {/* ---- header ---- */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-[22px] font-semibold tracking-tight">
                {battle.name}
              </h2>
              <StatusPill status={battle.status} />
            </div>
            <p className="num mt-1 text-xs text-muted">
              hosted by {shortName({ display_name: battle.host_name })} · tier 1 at{" "}
              {battle.tier_base}, +{battle.tier_step} a tier · 30-minute matches ·{" "}
              {fmtDur(battle.duration_s)}
            </p>
          </div>
          <div className="text-right">
            {battle.status === "scheduled" && (
              <>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  Starts in
                </div>
                <BigClock ms={startsMs - now} urgentUnderMs={60_000} title="Until the start" />
                <div className="mt-1 text-xs text-muted">
                  <LocalTime iso={battle.starts_at} mode="daytime" />
                </div>
              </>
            )}
            {battle.status === "active" && (
              <>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  Until the bell
                </div>
                <BigClock ms={endsMs - now} urgentUnderMs={5 * 60_000} title="Until the bell" />
              </>
            )}
            {battle.status === "closing" && (
              <div className="text-sm text-muted">The bell has gone — last matches finishing</div>
            )}
            {battle.status === "finished" && battle.finished_at && (
              <div className="text-sm text-muted">
                Finished <LocalTime iso={battle.finished_at} mode="daytime" />
              </div>
            )}
          </div>
        </div>
        {!detectable && (
          <p className="mt-3 text-sm text-muted">
            The sync worker isn&apos;t running — nobody will be paired and no
            solve will be noticed until it is.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-wa">
            {error}
          </p>
        )}
      </Card>

      {/* ---- lobby ---- */}
      {battle.status === "scheduled" && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>
              Lobby · {battle.players.length}/{battle.max_players}
            </Label>
            <AlertsToggle {...alerts} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {battle.players.map((p) => (
              <span
                key={p.user_id}
                className={`flex items-center gap-1.5 rounded-full border bg-page py-1 pl-1 pr-2.5 text-xs ${
                  p.user_id === meId ? "border-accent/60" : "border-line"
                }`}
              >
                <Avatar user={p} size={20} />
                {p.user_id === meId ? "You" : shortName(p)}
                {p.user_id === battle.host_id && (
                  <span className="text-[10px] uppercase tracking-[0.08em] text-muted">host</span>
                )}
              </span>
            ))}
          </div>
          <p className="mt-3 text-sm text-muted">
            Everyone starts at tier 1, paired in join order the moment it opens.
            Joining closes at the start.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!me && (
              <ActionButton
                disabled={busy || battle.players.length >= battle.max_players}
                onClick={() => action("join")}
              >
                {battle.players.length >= battle.max_players ? "Full" : "Join"}
              </ActionButton>
            )}
            {me && !isHost && (
              <ActionButton tone="quiet" disabled={busy} onClick={() => action("leave")}>
                Leave
              </ActionButton>
            )}
            {isHost && (
              <>
                <ActionButton
                  disabled={busy || battle.players.length < 2}
                  onClick={() => action("start")}
                >
                  Start now
                </ActionButton>
                <ActionButton tone="quiet" disabled={busy} onClick={() => action("cancel")}>
                  Cancel
                </ActionButton>
              </>
            )}
          </div>
        </Card>
      )}

      {/* ---- live ---- */}
      {(battle.status === "active" || battle.status === "closing") && (
        <>
          {battle.status === "closing" && (
            <div className="rounded-xl border border-accent/40 bg-accent-soft/50 px-4 py-2.5 text-sm">
              The bell has gone — no new matches. The ones still running finish on
              their own clocks, then it&apos;s over.
            </div>
          )}
          {me?.state === "eliminated" && (
            <div className="rounded-xl border border-line bg-card-2 px-4 py-2.5 text-sm">
              <strong>You&apos;re out</strong> — alone at tier {me.tier}, with nobody
              below to climb up to you. Spectating from here; the ladder and the
              feed keep going.
            </div>
          )}
          {myMatch && (
            <MyMatchCard
              battle={battle}
              match={myMatch}
              meId={meId}
              now={now}
              busy={busy}
              onForfeit={() => action("forfeit")}
              alerts={alerts}
            />
          )}
          {me && !myMatch && me.state !== "eliminated" && (
            <QueueControls
              battle={battle}
              me={me}
              busy={busy}
              action={action}
              alerts={alerts}
            />
          )}
          {!me && (
            <Card>
              <p className="text-sm text-muted">
                You&apos;re watching this one — joining closed when it started.
              </p>
            </Card>
          )}
          <Card>
            <Label>Ladder</Label>
            <TierLadder battle={battle} meId={meId} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <Label>Matches</Label>
              {battle.matches.length === 0 ? (
                <p className="text-sm text-muted">Pairing up…</p>
              ) : (
                <ul className="space-y-1">
                  {battle.matches.slice(0, 12).map((m) => (
                    <MatchRow key={m.id} m={m} meId={meId} />
                  ))}
                </ul>
              )}
            </Card>
            <LiveFeed items={items} live={live} />
          </div>
        </>
      )}

      {/* ---- the record ---- */}
      {battle.status === "finished" && (
        <>
          <Card>
            <Label>
              {battle.champion_id === meId
                ? "You win the arena"
                : battle.champion_name
                  ? `${shortName({ display_name: battle.champion_name })} wins the arena`
                  : "The arena is over"}
            </Label>
            <Podium battle={battle} meId={meId} />
          </Card>
          <Card>
            <Label>Final ladder</Label>
            <TierLadder battle={battle} meId={meId} />
          </Card>
          <Card>
            <Label>Records</Label>
            <RecordList battle={battle} meId={meId} />
          </Card>
          <LiveFeed items={items} live={false} max={100} />
        </>
      )}

      {battle.status === "cancelled" && (
        <Card>
          <p className="text-sm text-muted">
            Cancelled — by the host, or because fewer than two people had joined
            when it was due to start.
          </p>
        </Card>
      )}
    </div>
  );
}

function MyMatchCard({
  battle,
  match,
  meId,
  now,
  busy,
  onForfeit,
  alerts,
}: {
  battle: Battle;
  match: BattleMatch;
  meId: number;
  now: number;
  busy: boolean;
  onForfeit: () => void;
  alerts: { supported: boolean; enabled: boolean; denied: boolean; toggle: () => void };
}) {
  const oppId = match.a_id === meId ? match.b_id : match.a_id;
  const opp = battle.players.find((p) => p.user_id === oppId) ?? null;
  const me = battle.players.find((p) => p.user_id === meId) ?? null;
  const remaining = Date.parse(match.deadline_at) - now;
  return (
    <section
      key={match.id}
      className="match-ready rounded-(--radius-card) border border-line bg-card p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Avatar user={me ?? {}} size={36} ring="var(--accent)" />
            <span className="text-sm font-medium">You</span>
          </div>
          <span className="font-display text-lg font-bold tracking-widest text-muted">VS</span>
          <div className="flex items-center gap-2">
            <Avatar user={opp ?? {}} size={36} />
            <span className="text-sm font-medium">{shortName(opp)}</span>
          </div>
          <TierPill battle={battle} tier={match.tier} />
        </div>
        <BigClock ms={remaining} urgentUnderMs={3 * 60_000} />
      </div>
      <a
        href={match.problem_url ?? "#"}
        target="_blank"
        rel="noreferrer"
        className="round-open mt-3 block rounded-xl border border-line bg-page p-4 transition-colors hover:border-accent/60"
      >
        <div className="text-[15px] font-semibold">{match.problem_title ?? "The problem"}</div>
        <div className="num mt-1 text-xs text-muted">
          {match.problem_rating ? `rated ${match.problem_rating} · ` : ""}
          opens on Codeforces
        </div>
      </a>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          First accepted solution climbs to tier {match.tier + 1}; the other side
          stays. Nothing in 30 minutes is a tie. Checked every few seconds on the
          judge&apos;s clock.
        </p>
        <div className="flex items-center gap-2">
          <AlertsToggle {...alerts} />
          <ActionButton tone="quiet" disabled={busy} onClick={onForfeit}>
            Concede
          </ActionButton>
        </div>
      </div>
    </section>
  );
}

function QueueControls({
  battle,
  me,
  busy,
  action,
  alerts,
}: {
  battle: Battle;
  me: BattlePlayer;
  busy: boolean;
  action: (a: string) => void;
  alerts: { supported: boolean; enabled: boolean; denied: boolean; toggle: () => void };
}) {
  const closing = battle.status === "closing";
  const sameTier = battle.players.filter(
    (p) => p.user_id !== me.user_id && p.state !== "eliminated" && p.tier === me.tier,
  );
  const pickFailed =
    me.pick_failed_at !== null &&
    me.queued_at !== null &&
    Date.parse(me.pick_failed_at) >= Date.parse(me.queued_at);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <TierPill battle={battle} tier={me.tier} size="lg" />
          <div className="text-sm">
            {me.state === "queued" ? (
              <span className="flex items-center gap-2">
                <span
                  className="live-dot size-2 rounded-full"
                  style={{ backgroundColor: "var(--accent)" }}
                />
                In the queue — waiting for someone at tier {me.tier}
                {sameTier.length === 0 && " (nobody else is there yet)"}
              </span>
            ) : closing ? (
              <span className="text-muted">The bell&apos;s gone — no new matches.</span>
            ) : (
              <span>
                {me.wins + me.losses + me.draws === 0
                  ? "Ready when you are."
                  : `${me.wins}W ${me.losses}L ${me.draws}D so far.`}{" "}
                <span className="text-muted">
                  {sameTier.length === 0
                    ? "Nobody else at your tier right now — queue anyway and you're paired the moment someone climbs to it."
                    : `${sameTier.length} other${sameTier.length === 1 ? "" : "s"} at your tier.`}
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AlertsToggle {...alerts} />
          {me.state === "queued" ? (
            <ActionButton tone="quiet" disabled={busy} onClick={() => action("unqueue")}>
              Leave queue
            </ActionButton>
          ) : (
            <ActionButton disabled={busy || closing} onClick={() => action("queue")}>
              {me.wins + me.losses + me.draws === 0 ? "Queue for a match" : "Queue again"}
            </ActionButton>
          )}
        </div>
      </div>
      {pickFailed && (
        <p className="mt-2 text-xs text-muted">
          No problem at this rating that both you and your would-be opponent
          haven&apos;t seen — still queued; the next pairing tries again.
        </p>
      )}
    </Card>
  );
}
