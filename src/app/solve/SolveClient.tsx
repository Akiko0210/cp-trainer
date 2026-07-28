"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Select from "@/components/Select";
import { Card, Label, VerdictBadge } from "@/components/ui";
import type { OpenAttempt, PickerTopic, Recommendation } from "@/lib/queries";
import { CATEGORIES, fmtDuration, MISTAKE_TAGS, TIERS } from "@/lib/taxonomy";

/*
  The solve loop: pick topic -> get one recommended problem -> Start problem
  (opens an attempt) -> solve ON CODEFORCES -> Got AC / Gave up -> the judge's
  verdicts for the window come back -> tag what went wrong (§6.2).
  The timer is the contest clock: large, tabular-mono, quiet until running.
*/

type Phase = "pick" | "running" | "review";
type Verdict = { verdict: string | null; submitted_at: string };

export default function SolveClient({
  topics,
  initialTopic,
  openAttempt,
}: {
  topics: PickerTopic[];
  initialTopic: string | null;
  openAttempt: OpenAttempt | null;
}) {
  const [phase, setPhase] = useState<Phase>(openAttempt ? "running" : "pick");
  const [topic, setTopic] = useState<string>(initialTopic ?? "");
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const skip = useRef(0);

  const [attempt, setAttempt] = useState<{
    id: number;
    startedAt: number;
    title: string;
    url: string;
    rating: number | null;
  } | null>(
    openAttempt
      ? {
          id: openAttempt.id,
          startedAt: new Date(openAttempt.started_at).getTime(),
          title: openAttempt.title,
          url: openAttempt.url,
          rating: openAttempt.rating,
        }
      : null,
  );
  const [firstSubmitAt, setFirstSubmitAt] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<"ac" | "gave_up" | null>(null);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [checking, setChecking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loadRec = useCallback(
    async (t: string, skipN: number) => {
      setRecLoading(true);
      setRecError(null);
      try {
        const res = await fetch(
          `/api/recommend?${new URLSearchParams({
            ...(t ? { topic: t } : {}),
            skip: String(skipN),
          })}`,
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "No recommendation");
        setRec(data);
        if (data === null && skipN > 0) {
          // ran past the end of the band — wrap around
          skip.current = 0;
        }
      } catch (e) {
        setRec(null);
        setRecError(e instanceof Error ? e.message : "Couldn't fetch a problem.");
      } finally {
        setRecLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (phase === "pick") loadRec(topic, skip.current);
  }, [phase, topic, loadRec]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }

  async function startProblem() {
    if (!rec) return;
    const res = await fetch("/api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problemId: rec.id }),
    });
    if (!res.ok) return showToast("Couldn't start the attempt.");
    const a = await res.json();
    setAttempt({
      id: a.id,
      startedAt: new Date(a.started_at).getTime(),
      title: rec.title,
      url: rec.url,
      rating: rec.rating,
    });
    setFirstSubmitAt(null);
    setOutcome(null);
    setVerdicts([]);
    setPhase("running");
    window.open(rec.url, "_blank", "noopener");
  }

  async function markFirstSubmit() {
    if (!attempt || firstSubmitAt) return;
    setFirstSubmitAt(Date.now());
    await fetch(`/api/attempts/${attempt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "first_submit" }),
    });
  }

  async function finish(o: "ac" | "gave_up") {
    if (!attempt) return;
    setOutcome(o);
    setPhase("review");
    setChecking(true);
    const res = await fetch(`/api/attempts/${attempt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "finish", outcome: o }),
    });
    if (res.ok) {
      const data = await res.json();
      setVerdicts(data.verdicts ?? []);
      if (!data.synced) showToast("Worker offline — verdicts sync later.");
    }
    setChecking(false);
  }

  async function recheck() {
    if (!attempt) return;
    setChecking(true);
    const res = await fetch(`/api/attempts/${attempt.id}`);
    if (res.ok) setVerdicts((await res.json()).verdicts ?? []);
    setChecking(false);
  }

  async function stopSession() {
    if (!attempt) return;
    await fetch(`/api/attempts/${attempt.id}`, { method: "DELETE" });
    setAttempt(null);
    setPhase("pick");
    showToast("Session discarded — nothing recorded.");
  }

  function nextProblem() {
    skip.current = 0;
    setAttempt(null);
    setPhase("pick");
  }

  // Picker: one optgroup per category — "all of it" first, then its modules
  // in tier order (they arrive division-sorted from the server).
  const byCategory = groupBy(topics, (t) => t.category_slug ?? "");

  return (
    <div className="pt-6">
      <div className="mb-5">
        <h1 className="font-display text-[26px] font-semibold tracking-tight">
          Solve
        </h1>
        <p className="mt-1 text-sm text-muted">
          One problem at a time, just above your level. Solve it on Codeforces —
          the timer runs here.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* ---- problem column ---- */}
        <div className="flex flex-col gap-4 lg:col-span-3">
          {phase === "pick" && (
            <Card>
              <Label>Topic</Label>
              <Select
                ariaLabel="Choose a topic to grind"
                value={topic}
                onChange={(v) => {
                  skip.current = 0;
                  setTopic(v);
                }}
                placeholder="Let the trainer choose (weak / stale first)"
                groups={[
                  {
                    label: "",
                    options: [
                      {
                        value: "",
                        label: "Let the trainer choose (weak / stale first)",
                      },
                    ],
                  },
                  ...CATEGORIES.map((c) => ({
                    label: c.name,
                    options: [
                      { value: `cat-${c.slug}`, label: `All of ${c.name}` },
                      ...(byCategory[`cat-${c.slug}`] ?? []).map((t) => ({
                        value: t.slug,
                        label: `${t.name} · ${TIERS[t.division]?.label ?? t.division}`,
                        hint:
                          (t.score != null ? String(Math.round(t.score)) : "") +
                          (t.stale ? " review" : ""),
                      })),
                    ],
                  })),
                ]}
              />

              <div className="mt-4 border-t border-line pt-4">
                {recLoading ? (
                  <div className="py-8 text-center text-sm text-muted">
                    Picking a problem…
                  </div>
                ) : rec ? (
                  <div>
                    <div className="flex items-baseline justify-between gap-3">
                      <h2 className="font-display text-lg font-semibold">
                        {rec.title}
                      </h2>
                      <span className="num shrink-0 text-sm font-semibold">
                        {rec.rating}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span>{rec.topic_name}</span>
                      {rec.curated && (
                        <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-dk">
                          curated
                        </span>
                      )}
                      {rec.difficulty_label && <span>{rec.difficulty_label}</span>}
                    </div>
                    <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                      {rec.why}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        onClick={startProblem}
                        className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90"
                      >
                        Start problem
                      </button>
                      <a
                        href={rec.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-xl border border-line px-4 py-2.5 text-sm hover:border-accent/50"
                      >
                        Peek on Codeforces
                      </a>
                      <button
                        onClick={() => {
                          skip.current += 1;
                          loadRec(topic, skip.current);
                        }}
                        className="rounded-xl border border-line px-4 py-2.5 text-sm text-muted hover:border-accent/50 hover:text-ink"
                      >
                        Skip
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="py-8 text-center text-sm text-muted">
                    {recError ??
                      "No unsolved problems in the right difficulty band here. Pick another topic."}
                  </div>
                )}
              </div>
            </Card>
          )}

          {phase !== "pick" && attempt && (
            <Card>
              <Label>{phase === "running" ? "In progress" : "Session review"}</Label>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display text-lg font-semibold">
                  {attempt.title}
                </h2>
                <span className="num shrink-0 text-sm font-semibold">
                  {attempt.rating ?? ""}
                </span>
              </div>
              <a
                href={attempt.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-sm text-accent hover:underline"
              >
                Open on Codeforces ↗
              </a>

              {phase === "review" && (
                <ReviewPanel
                  outcome={outcome}
                  verdicts={verdicts}
                  checking={checking}
                  onRecheck={recheck}
                  attemptId={attempt.id}
                  onLogged={() => showToast("Mistake logged")}
                  onNext={nextProblem}
                />
              )}
            </Card>
          )}
        </div>

        {/* ---- clock column ---- */}
        <div className="lg:col-span-2">
          <Clock
            phase={phase}
            startedAt={attempt?.startedAt ?? null}
            firstSubmitAt={firstSubmitAt}
            onFirstSubmit={markFirstSubmit}
            onFinish={finish}
            onStop={stopSession}
          />
        </div>
      </div>

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

function Clock({
  phase,
  startedAt,
  firstSubmitAt,
  onFirstSubmit,
  onFinish,
  onStop,
}: {
  phase: Phase;
  startedAt: number | null;
  firstSubmitAt: number | null;
  onFirstSubmit: () => void;
  onFinish: (o: "ac" | "gave_up") => void;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = phase === "running" && startedAt != null;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  const elapsed = running ? (now - startedAt!) / 1000 : 0;

  return (
    <Card className="sticky top-20 text-center">
      <Label>Contest clock</Label>
      <div
        className={`num text-[56px] font-semibold leading-none tracking-tight ${
          running ? "" : "text-muted/40"
        }`}
        aria-live="off"
      >
        {running ? fmtDuration(elapsed) : "00:00"}
      </div>
      {running ? (
        <>
          <div className="num mt-2 text-xs text-muted">
            {firstSubmitAt
              ? `first submit at ${fmtDuration((firstSubmitAt - startedAt!) / 1000)} — debugging`
              : "thinking / implementing"}
          </div>
          <div className="mt-5 flex flex-col gap-2">
            {!firstSubmitAt && (
              <button
                onClick={onFirstSubmit}
                className="rounded-xl border border-line px-4 py-2.5 text-sm hover:border-accent/50"
              >
                Mark first submit
              </button>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onFinish("ac")}
                className="rounded-xl bg-ac-soft px-4 py-2.5 text-sm font-semibold text-ac hover:opacity-85"
              >
                Got AC
              </button>
              <button
                onClick={() => onFinish("gave_up")}
                className="rounded-xl bg-card-2 px-4 py-2.5 text-sm font-medium text-muted hover:text-ink"
              >
                Gave up
              </button>
            </div>
            <button
              onClick={onStop}
              className="mt-1 text-xs text-muted underline decoration-line underline-offset-4 hover:text-ink"
            >
              Stop — discard this session
            </button>
          </div>
        </>
      ) : (
        <div className="mt-2 text-xs text-muted">
          {phase === "review" ? "session closed" : "starts with the problem"}
        </div>
      )}
    </Card>
  );
}

function ReviewPanel({
  outcome,
  verdicts,
  checking,
  onRecheck,
  attemptId,
  onLogged,
  onNext,
}: {
  outcome: "ac" | "gave_up" | null;
  verdicts: Verdict[];
  checking: boolean;
  onRecheck: () => void;
  attemptId: number;
  onLogged: () => void;
  onNext: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [logged, setLogged] = useState(false);
  const failed = verdicts.filter((v) => v.verdict !== "OK").length;
  const shouldTag = outcome === "gave_up" || failed > 0;

  async function log() {
    const res = await fetch("/api/mistakes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId, tags: [...selected], note }),
    });
    if (res.ok) {
      setLogged(true);
      onLogged();
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted">Judge saw:</span>
        {checking ? (
          <span className="text-[13px] text-muted">checking…</span>
        ) : verdicts.length === 0 ? (
          <>
            <span className="text-[13px] text-muted">
              no submissions in this window yet
            </span>
            <button
              onClick={onRecheck}
              className="rounded-lg border border-line px-2.5 py-1 text-xs hover:border-accent/50"
            >
              Check again
            </button>
          </>
        ) : (
          <>
            {verdicts.map((v, i) => (
              <VerdictBadge key={i} verdict={v.verdict} />
            ))}
            {verdicts.some((v) => v.verdict === "TESTING" || v.verdict == null) && (
              <button
                onClick={onRecheck}
                className="rounded-lg border border-line px-2.5 py-1 text-xs hover:border-accent/50"
              >
                Check again
              </button>
            )}
          </>
        )}
      </div>

      {shouldTag && !logged && (
        <div className="mt-4">
          <div className="mb-2 text-sm font-medium">What went wrong?</div>
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
                  className={`rounded-(--radius-chip) border px-2.5 py-1.5 text-[13px] transition-colors ${
                    on
                      ? "border-accent bg-accent text-accent-ink"
                      : "border-line bg-card text-muted hover:border-accent/50 hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note — what exactly bit you?"
            rows={2}
            className="mt-3 w-full rounded-xl border border-line bg-page px-3 py-2 text-sm placeholder:text-muted/60"
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={log}
              disabled={selected.size === 0}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
            >
              Log mistake
            </button>
            <button
              onClick={onNext}
              className="rounded-xl border border-line px-4 py-2 text-sm text-muted hover:text-ink"
            >
              Skip tagging
            </button>
          </div>
        </div>
      )}

      {(logged || !shouldTag) && (
        <div className="mt-4 flex items-center gap-3">
          {logged && (
            <span className="text-sm text-muted">
              Logged — it feeds the mistake analytics.
            </span>
          )}
          {!shouldTag && outcome === "ac" && (
            <span className="text-sm text-muted">Clean solve. Nice.</span>
          )}
          <button
            onClick={onNext}
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            Next problem
          </button>
        </div>
      )}
    </div>
  );
}

function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) (out[key(item)] ??= []).push(item);
  return out;
}
