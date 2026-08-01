"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Select from "@/components/Select";
import { Card, Label } from "@/components/ui";
import type {
  ContestSet,
  OpenSession,
  SessionResult,
  SetProblem,
} from "@/lib/icpc-queries";
import {
  fmtDuration,
  ICPC_LEVELS,
  MISTAKE_LABELS,
  MISTAKE_TAGS,
} from "@/lib/taxonomy";

/*
  One ICPC set, two modes.

  Browsing  — the problem list, each row openable on Kattis, with a manual
              "solved" toggle (Kattis can't be mirrored, so the user asserts it)
              and a per-problem timer.
  Contest   — a virtual run: one countdown clock over the whole set, one
              problem worked at a time, splits measured from the contest start,
              then a scoreboard-style summary with mistake tagging.

  All state lives in server rows, so a reload mid-contest restores exactly.
*/

const DURATIONS = [
  { label: "5 hours · ICPC standard", value: 5 * 3600 },
  { label: "3 hours", value: 3 * 3600 },
  { label: "2 hours", value: 2 * 3600 },
];

export default function SetClient({
  set,
  problems,
  session,
  otherContestRunning,
}: {
  set: ContestSet;
  problems: SetProblem[];
  session: OpenSession | null;
  otherContestRunning: boolean;
}) {
  const router = useRouter();
  const [duration, setDuration] = useState(DURATIONS[0].value);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [summary, setSummary] = useState<SessionResult[] | null>(null);
  const [tagging, setTagging] = useState<number | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }

  const solvedCount = problems.filter((p) => p.solved).length;
  const working = problems.find((p) => p.attempt_id && !p.attempt_ended_at);

  async function startContest() {
    setBusy(true);
    const res = await fetch("/api/icpc/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setSlug: set.slug, durationS: duration }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => null);
      return showToast(b?.error ?? "Couldn't start the contest.");
    }
    router.refresh();
  }

  async function endContest() {
    if (!session) return;
    setBusy(true);
    const res = await fetch(`/api/icpc/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "end" }),
    });
    setBusy(false);
    if (res.ok) {
      const data = await res.json();
      setSummary(data.results ?? []);
      router.refresh();
    }
  }

  async function work(problem: SetProblem) {
    const res = await fetch("/api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problemId: problem.id, inSession: !!session }),
    });
    if (!res.ok) return showToast("Couldn't start the timer.");
    window.open(problem.url, "_blank", "noopener");
    router.refresh();
  }

  async function finishAttempt(problem: SetProblem, outcome: "ac" | "gave_up") {
    if (!problem.attempt_id) return;
    const res = await fetch(`/api/attempts/${problem.attempt_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "finish", outcome }),
    });
    if (!res.ok) return showToast("Couldn't record that.");
    showToast(outcome === "ac" ? "Solved — nice." : "Parked.");
    if (outcome === "gave_up") setTagging(problem.attempt_id);
    router.refresh();
  }

  async function toggleSolved(problem: SetProblem) {
    const res = await fetch(`/api/problems/${problem.id}/solved`, {
      method: problem.solved ? "DELETE" : "POST",
    });
    if (!res.ok) {
      const b = await res.json().catch(() => null);
      return showToast(b?.error ?? "Couldn't update that.");
    }
    showToast(problem.solved ? "Unmarked." : "Marked solved.");
    router.refresh();
  }

  return (
    <div style={{ "--icpc-local": "var(--icpc)" } as React.CSSProperties}>
      {/* header band */}
      <div
        className="mb-4 rounded-(--radius-card) border border-line p-6"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in oklab, var(--icpc) 12%, transparent), color-mix(in oklab, var(--icpc) 3%, transparent))",
        }}
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              {[
                ICPC_LEVELS[set.level]?.label ?? set.level,
                set.series,
                set.year,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <h1 className="font-display mt-1 text-[26px] font-semibold tracking-tight">
              {set.name}
            </h1>
            <div className="num mt-2 text-sm text-muted">
              {solvedCount}/{problems.length} solved
            </div>
          </div>

          {session ? (
            <ContestClock
              session={session}
              onEnd={endContest}
              busy={busy}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                ariaLabel="Contest length"
                className="w-52"
                accent="var(--icpc)"
                value={String(duration)}
                onChange={(v) => setDuration(Number(v))}
                options={DURATIONS.map((d) => ({
                  value: String(d.value),
                  label: d.label,
                }))}
              />
              <button
                onClick={startContest}
                disabled={busy || otherContestRunning}
                title={
                  otherContestRunning
                    ? "Finish the contest you already have running first"
                    : undefined
                }
                className="rounded-xl px-5 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
                style={{ backgroundColor: "var(--icpc)" }}
              >
                Start virtual contest
              </button>
            </div>
          )}
        </div>
      </div>

      {summary && <Summary results={summary} onDismiss={() => setSummary(null)} />}

      <Card>
        <Label>
          {session ? "The board" : "Problems"} ·{" "}
          <span className="num">{problems.length}</span>
        </Label>
        <ul className="divide-y divide-line">
          {problems.map((p, i) => {
            const isWorking = working?.id === p.id;
            const attempted = !!p.attempt_id;
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                <span className="num w-5 shrink-0 text-sm text-muted">
                  {String.fromCharCode(65 + i)}
                </span>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-sm hover:text-accent"
                >
                  {p.title}
                </a>
                {p.kattis_difficulty != null && (
                  <span
                    className="num shrink-0 text-xs text-muted"
                    title="Kattis difficulty (1–10)"
                  >
                    {p.kattis_difficulty.toFixed(1)}
                  </span>
                )}

                {p.solved ? (
                  <span className="num shrink-0 rounded-md bg-ac-soft px-1.5 py-0.5 text-[11px] font-semibold text-ac">
                    AC
                  </span>
                ) : attempted && !isWorking ? (
                  <span className="num shrink-0 rounded-md bg-card-2 px-1.5 py-0.5 text-[11px] text-muted">
                    tried
                  </span>
                ) : null}

                {/* Two buttons plus a title do not fit across a phone, and the
                    title is the part worth reading — so below sm the actions
                    take their own line instead of truncating it to nothing. */}
                <span className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:ml-auto sm:w-auto">
                  {isWorking ? (
                    <>
                      <button
                        onClick={() => finishAttempt(p, "ac")}
                        className="rounded-lg bg-ac-soft px-3 py-1.5 text-[13px] font-semibold text-ac hover:opacity-85"
                      >
                        Solved
                      </button>
                      <button
                        onClick={() => finishAttempt(p, "gave_up")}
                        className="rounded-lg bg-card-2 px-3 py-1.5 text-[13px] text-muted hover:text-ink"
                      >
                        Park
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => work(p)}
                        disabled={!!working}
                        title={working ? "Finish the problem you're on first" : undefined}
                        className="rounded-lg border border-line px-3 py-1.5 text-[13px] hover:border-accent/50 disabled:opacity-30"
                      >
                        {session ? "Work on this" : "Start timer"}
                      </button>
                      {!session && (
                        <button
                          onClick={() => toggleSolved(p)}
                          className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-muted hover:border-accent/50 hover:text-ink"
                        >
                          {p.solved ? "Unmark" : "Mark solved"}
                        </button>
                      )}
                    </>
                  )}
                </span>

                {p.attempt_id != null && tagging === p.attempt_id && (
                  <TagRow
                    attemptId={p.attempt_id}
                    onDone={() => {
                      setTagging(null);
                      showToast("Mistake logged");
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted">
          Kattis has no public API and blocks profile scraping, so solves here
          are recorded by you — the timer records one automatically when you hit
          Solved.
        </p>
      </Card>

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-line bg-card px-4 py-2.5 text-sm shadow-lg shadow-black/15"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function ContestClock({
  session,
  onEnd,
  busy,
}: {
  session: OpenSession;
  onEnd: () => void;
  busy: boolean;
}) {
  const endsAt = new Date(session.started_at).getTime() + session.duration_s * 1000;
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, (endsAt - Date.now()) / 1000),
  );

  useEffect(() => {
    const t = setInterval(
      () => setRemaining(Math.max(0, (endsAt - Date.now()) / 1000)),
      500,
    );
    return () => clearInterval(t);
  }, [endsAt]);

  const expired = remaining <= 0;
  return (
    <div className="text-right">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
        {expired ? "Time called" : "Time remaining"}
      </div>
      <div
        className="num text-[44px] font-bold leading-none tabular-nums"
        style={{ color: expired ? "var(--wa)" : "var(--icpc)" }}
        aria-live="off"
      >
        {fmtDuration(remaining)}
      </div>
      <button
        onClick={onEnd}
        disabled={busy}
        className="mt-2 rounded-xl border border-line px-4 py-2 text-sm hover:border-accent/50 disabled:opacity-50"
      >
        End contest
      </button>
    </div>
  );
}

function TagRow({
  attemptId,
  onDone,
}: {
  attemptId: number;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  async function log() {
    await fetch("/api/mistakes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId, tags: [...selected] }),
    });
    onDone();
  }
  return (
    <div className="mt-1 w-full border-t border-line pt-2.5">
      <div className="mb-2 text-[13px] text-muted">What went wrong?</div>
      <div className="flex flex-wrap gap-1.5">
        {MISTAKE_TAGS.map((t) => {
          const on = selected.has(t.tag);
          return (
            <button
              key={t.tag}
              title={t.hint}
              aria-pressed={on}
              onClick={() => {
                const next = new Set(selected);
                if (on) next.delete(t.tag);
                else next.add(t.tag);
                setSelected(next);
              }}
              className={`rounded-(--radius-chip) border px-2.5 py-1 text-[13px] ${
                on
                  ? "border-accent bg-accent text-accent-ink"
                  : "border-line text-muted hover:border-accent/50 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          );
        })}
        <button
          onClick={log}
          disabled={selected.size === 0}
          className="rounded-(--radius-chip) bg-accent px-3 py-1 text-[13px] font-medium text-accent-ink disabled:opacity-40"
        >
          Log mistake
        </button>
        <button
          onClick={onDone}
          className="rounded-(--radius-chip) px-2.5 py-1 text-[13px] text-muted hover:text-ink"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function Summary({
  results,
  onDismiss,
}: {
  results: SessionResult[];
  onDismiss: () => void;
}) {
  const solved = results.filter((r) => r.solved);
  // ICPC scoring: total penalty = sum of solve times in minutes.
  const penalty = solved.reduce(
    (s, r) => s + Math.round((r.solved_at_s ?? 0) / 60),
    0,
  );
  return (
    <Card className="mb-4">
      <Label>Contest over</Label>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="num text-[28px] font-bold leading-none">
          {solved.length}
          <span className="text-base font-normal text-muted">
            {" "}
            solved of {results.length} opened
          </span>
        </span>
        {solved.length > 0 && (
          <span className="num text-sm text-muted">
            penalty <b className="text-ink">{penalty}</b>
          </span>
        )}
      </div>
      {results.length === 0 ? (
        <p className="text-sm text-muted">
          You didn&apos;t open anything this run — no splits to show.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {results.map((r) => (
            <li key={r.problem_id} className="flex items-center gap-3 py-2">
              <span
                className={`num shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
                  r.solved ? "bg-ac-soft text-ac" : "bg-card-2 text-muted"
                }`}
              >
                {r.solved ? "AC" : "—"}
              </span>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm hover:text-accent"
              >
                {r.title}
              </a>
              {r.tags.length > 0 && (
                <span className="hidden gap-1 sm:flex">
                  {r.tags.map((t, i) => (
                    <span
                      key={i}
                      className="rounded-md bg-card-2 px-1.5 py-0.5 text-[11px] text-muted"
                    >
                      {MISTAKE_LABELS[t] ?? t}
                    </span>
                  ))}
                </span>
              )}
              <span className="num w-20 shrink-0 text-right text-xs text-muted">
                {r.solved && r.solved_at_s != null
                  ? `+${Math.round(r.solved_at_s / 60)}m`
                  : `${r.minutes_spent ?? 0}m spent`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button
        onClick={onDismiss}
        className="mt-3 rounded-xl border border-line px-4 py-2 text-sm hover:border-accent/50"
      >
        Done
      </button>
    </Card>
  );
}
