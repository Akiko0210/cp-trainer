"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ActionButton, fmtDur, LoadingCard, useAct } from "./arena-ui";
import { countdown, useNowMs } from "./contest-ui";
import { useGuildLive } from "./GuildLive";
import { Avatar, shortName } from "./guild-ui";
import LocalTime from "./LocalTime";
import Select from "./Select";
import { Card, Label } from "./ui";
import { BATTLE_LIMITS } from "@/lib/arena-rules";
import type { Battle, BattleStatus } from "@/lib/battle-queries";

/*
  The battle arena's front door: the one open battle (schedule it, join it,
  enter its room) and the ones that already happened. The room itself is
  /guild/battles/[id] — a battle lasts hours and has a ladder, a match card
  and a feed to show, which is a page, not a panel.
*/

type BattlesState = {
  open: Battle | null;
  recent: Battle[];
  detectable: boolean;
};

const DURATIONS_MIN = [30, 45, 60, 90, 120, 180, 240, 360, 480] as const;
const SIZES = [4, 6, 8, 12, 16, 24, 32, 48, 64] as const;
const BASES = Array.from({ length: 23 }, (_, i) => 800 + i * 100);

/** Local wall-clock string for <input type="datetime-local">: 15 minutes
    out, rounded to the next 5. */
function defaultStart(): string {
  const d = new Date(Date.now() + 15 * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function StatusPill({ status }: { status: BattleStatus }) {
  const label =
    status === "scheduled"
      ? "scheduled"
      : status === "active"
        ? "live"
        : status === "closing"
          ? "closing"
          : status === "finished"
            ? "finished"
            : "cancelled";
  const tone =
    status === "active"
      ? "bg-accent text-accent-ink"
      : status === "closing"
        ? "bg-accent-soft text-accent-dk"
        : "bg-card-2 text-muted";
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] ${tone}`}>
      {label}
    </span>
  );
}

export default function BattlesPanel({ meId }: { meId: number }) {
  const { version } = useGuildLive();
  const [state, setState] = useState<BattlesState | null>(null);
  const now = useNowMs();
  // The form. A wall-clock default is safe here because the form is never
  // server-rendered: the panel shows LoadingCard until its first fetch lands.
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState(defaultStart);
  const [minutes, setMinutes] = useState("60");
  const [size, setSize] = useState("8");
  const [base, setBase] = useState("1000");
  const [step, setStep] = useState("200");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/guild/battles");
      if (res.ok) setState((await res.json()) as BattlesState);
    } catch {
      // Keep the last good state; the next event retries.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/guild/battles");
        if (!res.ok || cancelled) return;
        setState((await res.json()) as BattlesState);
      } catch {
        // Transient failure — the next version bump retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  const { act, busy, error } = useAct(load);

  if (!state) return <LoadingCard />;

  const open = state.open;
  const me = open?.players.find((p) => p.user_id === meId) ?? null;
  const isHost = open?.host_id === meId;
  const startsMs = open ? Date.parse(open.starts_at) : null;

  return (
    <Card>
      {!state.detectable && (
        <p className="mb-3 text-sm text-muted">
          Battles need the sync worker — it pairs players and detects solves
          from the Codeforces mirror, and nothing is watching it right now.
        </p>
      )}

      {/* ---- nothing open: schedule one ---- */}
      {!open && (
        <div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Name it (optional)"
              aria-label="Battle name"
              className="rounded-(--radius-chip) border border-line bg-card px-3 py-2 text-sm"
            />
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              aria-label="Starts at"
              className="num rounded-(--radius-chip) border border-line bg-card px-3 py-2 text-sm"
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <Select
              value={minutes}
              onChange={setMinutes}
              ariaLabel="How long the battle runs"
              className="w-32"
              options={DURATIONS_MIN.map((m) => ({ value: String(m), label: fmtDur(m * 60) }))}
            />
            <Select
              value={size}
              onChange={setSize}
              ariaLabel="Maximum players"
              className="w-36"
              options={SIZES.map((n) => ({
                value: String(n),
                label: `up to ${n} players`,
              }))}
            />
            <Select
              value={base}
              onChange={setBase}
              ariaLabel="Tier 1 rating"
              className="w-36"
              options={BASES.map((r) => ({ value: String(r), label: `tier 1 at ${r}` }))}
            />
            <Select
              value={step}
              onChange={setStep}
              ariaLabel="Rating step per tier"
              className="w-32"
              options={BATTLE_LIMITS.tierSteps.map((s) => ({
                value: String(s),
                label: `+${s} a tier`,
              }))}
            />
            <ActionButton
              disabled={busy || !state.detectable || !startsAt}
              onClick={() =>
                void act("/api/guild/battles", {
                  name,
                  starts_at: new Date(startsAt).toISOString(),
                  duration_s: Number(minutes) * 60,
                  max_players: Number(size),
                  tier_base: Number(base),
                  tier_step: Number(step),
                })
              }
            >
              Schedule the battle
            </ActionButton>
          </div>
          <p className="mt-2 text-xs text-muted">
            Everyone starts at tier 1 and is paired inside their tier; a win
            climbs one, a tie or a loss stays, nobody drops. Matches are 30
            minutes on one problem at the tier&apos;s rating. Alone at the bottom
            tier and you&apos;re out — last one standing wins.
            {Number(size) > 16 && (
              <>
                {" "}
                With more than 16 people in matches at once, solves are noticed
                about a minute late — Codeforces allows one look every two
                seconds.
              </>
            )}
          </p>
        </div>
      )}

      {/* ---- the open battle ---- */}
      {open && (
        <div>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-display text-lg font-semibold">{open.name}</span>
                <StatusPill status={open.status} />
              </div>
              <div className="num mt-0.5 text-xs text-muted">
                hosted by {shortName({ display_name: open.host_name })} · tier 1 at{" "}
                {open.tier_base}, +{open.tier_step} a tier · {fmtDur(open.duration_s)} ·
                up to {open.max_players} players
              </div>
            </div>
            <Link
              href={`/guild/battles/${open.id}`}
              className="rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
            >
              {open.status === "scheduled" ? "Open the lobby →" : "Enter the arena →"}
            </Link>
          </div>

          <p className="mt-3 text-sm">
            {open.status === "scheduled" && startsMs !== null && (
              <>
                Starts{" "}
                <strong className="num">
                  {now === null ? "" : countdown(startsMs - now)}
                </strong>{" "}
                — <LocalTime iso={open.starts_at} mode="daytime" />. Joining closes at
                the start.
              </>
            )}
            {open.status === "active" && (
              <>
                Live now — the bell rings <LocalTime iso={open.ends_at} mode="daytime" />.
              </>
            )}
            {open.status === "closing" && <>The bell has gone — the last matches are finishing.</>}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {open.players.map((p) => (
              <span
                key={p.user_id}
                className={`flex items-center gap-1.5 rounded-full border bg-page py-1 pl-1 pr-2.5 text-xs ${
                  p.user_id === meId ? "border-accent/60" : "border-line"
                } ${p.state === "eliminated" ? "opacity-55" : ""}`}
              >
                <Avatar user={p} size={20} />
                {p.user_id === meId ? "You" : shortName(p)}
                {open.status !== "scheduled" && (
                  <span className="num text-muted">t{p.tier}</span>
                )}
              </span>
            ))}
            <span className="num text-xs text-muted">
              {open.players.length}/{open.max_players}
            </span>
          </div>

          {open.status === "scheduled" && (
            <div className="mt-3 flex flex-wrap gap-2">
              {!me && (
                <ActionButton
                  disabled={busy || open.players.length >= open.max_players}
                  onClick={() => void act(`/api/guild/battles/${open.id}`, { action: "join" })}
                >
                  {open.players.length >= open.max_players ? "Full" : "Join"}
                </ActionButton>
              )}
              {me && !isHost && (
                <ActionButton
                  tone="quiet"
                  disabled={busy}
                  onClick={() => void act(`/api/guild/battles/${open.id}`, { action: "leave" })}
                >
                  Leave
                </ActionButton>
              )}
              {isHost && (
                <>
                  <ActionButton
                    disabled={busy || open.players.length < 2}
                    onClick={() => void act(`/api/guild/battles/${open.id}`, { action: "start" })}
                  >
                    Start now
                  </ActionButton>
                  <ActionButton
                    tone="quiet"
                    disabled={busy}
                    onClick={() => void act(`/api/guild/battles/${open.id}`, { action: "cancel" })}
                  >
                    Cancel
                  </ActionButton>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-wa">
          {error}
        </p>
      )}

      {/* ---- the record ---- */}
      {state.recent.length > 0 && (
        <div className="mt-5 border-t border-line pt-3">
          <Label>Recent battles</Label>
          <ul className="space-y-1.5">
            {state.recent.map((b) => (
              <li key={b.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <Link href={`/guild/battles/${b.id}`} className="font-medium hover:underline">
                  {b.name}
                </Link>
                <span className="text-muted">
                  {b.champion_name ? (
                    <>
                      <strong className="text-ink">
                        {shortName({ display_name: b.champion_name })}
                      </strong>{" "}
                      won
                    </>
                  ) : (
                    "no champion"
                  )}
                  {" · "}
                  {b.players.length} players · {b.matches.length} matches
                </span>
                <span className="num ml-auto text-xs text-muted">
                  {b.started_at && <LocalTime iso={b.started_at} mode="daytime" />}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
