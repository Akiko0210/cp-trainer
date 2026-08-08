"use client";

import { useMemo, useState } from "react";
import LocalTime from "./LocalTime";
import {
  countdown,
  durationLabel,
  PlatformMark,
  ReminderToggle,
  useContestReminders,
  useNowMs,
} from "./contest-ui";
import { Card, Empty } from "./ui";
import type { UpcomingContest } from "@/lib/queries";

/*
  The full calendar: every upcoming round the worker knows about, filtered by
  judge and by how far ahead you care to look.

  Grouped by day, because a date repeated on twelve consecutive rows is noise —
  the heading says it once and each row only has to say a time. Which day a
  contest falls on depends on the viewer's zone, so grouping is UTC until
  hydration (matching the server) and regroups the moment the browser's zone
  is known. Same bargain LocalTime makes: correct-but-labelled first, local
  immediately after, never a silent seven-hour lie.

  Reminders are scheduled from the UNFILTERED list on purpose. The filter is a
  view of the board; it should not quietly decide which rounds you get told
  about.
*/

type Window = { label: string; days: number | null };

const WINDOWS: Window[] = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "All", days: null },
];

export default function ContestBoard({
  contests,
  workerConfigured,
}: {
  contests: UpcomingContest[];
  workerConfigured: boolean;
}) {
  const now = useNowMs();
  const reminders = useContestReminders(contests);

  const [platforms, setPlatforms] = useState<Set<string>>(new Set());
  const [windowDays, setWindowDays] = useState<number | null>(null);

  // Judges that actually have something scheduled — a chip for an empty judge
  // is a dead control.
  const available = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of contests) counts.set(c.platform, (counts.get(c.platform) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [contests]);

  const shown = useMemo(() => {
    const cutoff =
      windowDays === null || now === null ? null : now + windowDays * 86400_000;
    return contests.filter(
      (c) =>
        (platforms.size === 0 || platforms.has(c.platform)) &&
        (cutoff === null || c.starts_at_ms <= cutoff),
    );
  }, [contests, platforms, windowDays, now]);

  // Group into days. Before hydration `now` is null and the keys are UTC, so
  // the server and the first client render agree.
  const groups = useMemo(() => {
    const local = now !== null;
    const out: { key: string; ms: number; rows: UpcomingContest[] }[] = [];
    for (const c of shown) {
      const d = new Date(c.starts_at_ms);
      const key = local
        ? d.toDateString()
        : d.toISOString().slice(0, 10);
      const last = out[out.length - 1];
      if (last?.key === key) last.rows.push(c);
      else out.push({ key, ms: c.starts_at_ms, rows: [c] });
    }
    return out;
  }, [shown, now]);

  const togglePlatform = (p: string) =>
    setPlatforms((prev) => {
      const next = new Set(prev);
      if (!next.delete(p)) next.add(p);
      return next;
    });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip active={platforms.size === 0} onClick={() => setPlatforms(new Set())}>
          All judges
        </Chip>
        {available.map(([platform, n]) => (
          <Chip
            key={platform}
            active={platforms.has(platform)}
            onClick={() => togglePlatform(platform)}
          >
            <PlatformMark platform={platform} size={16} />
            {platform}
            <span className="num opacity-60">{n}</span>
          </Chip>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-lg border border-line p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                onClick={() => setWindowDays(w.days)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  windowDays === w.days
                    ? "bg-accent-soft font-medium text-accent-dk"
                    : "text-muted hover:text-ink"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <ReminderToggle {...reminders} className="py-1" />
        </div>
      </div>

      {groups.length === 0 ? (
        <Card>
          <Empty title="Nothing here">
            {contests.length === 0
              ? workerConfigured
                ? "No upcoming contests are mirrored yet. The worker refreshes the calendar every few hours."
                : "The worker mirrors the judges' calendars — without one this page stays empty."
              : "No contests match these filters."}
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                <DayHeading ms={g.ms} now={now} />
              </h2>
              {/* Not <Card>: its p-5 and a p-0 override are the same CSS
                  property at the same specificity, so which wins is stylesheet
                  order, not class order. Rows own their own padding. */}
              <div className="overflow-hidden rounded-(--radius-card) border border-line bg-card">
                <ul className="divide-y divide-line">
                  {g.rows.map((c) => {
                    const msLeft = now === null ? null : c.starts_at_ms - now;
                    const soon = msLeft !== null && msLeft < 60 * 60 * 1000;
                    return (
                      <li key={c.id}>
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-3 px-4 py-2.5 hover:bg-card-2"
                        >
                          <PlatformMark platform={c.platform} />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {c.name}
                          </span>
                          <span className="num hidden shrink-0 text-xs text-muted sm:block">
                            <LocalTime
                              iso={new Date(c.starts_at_ms).toISOString()}
                              mode="time"
                            />{" "}
                            · {durationLabel(c.duration_s)}
                          </span>
                          {msLeft !== null && (
                            <span
                              className={`num w-20 shrink-0 text-right text-xs ${
                                soon ? "font-semibold text-accent" : "text-muted"
                              }`}
                            >
                              {countdown(msLeft)}
                            </span>
                          )}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-accent/40 bg-accent-soft font-medium text-accent-dk"
          : "border-line text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** "Today" / "Tomorrow" once the zone is known; an honest UTC date before. */
function DayHeading({ ms, now }: { ms: number; now: number | null }) {
  if (now === null) {
    return (
      <>
        {new Intl.DateTimeFormat("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date(ms))}{" "}
        UTC
      </>
    );
  }
  const day = new Date(ms).toDateString();
  const today = new Date(now).toDateString();
  const tomorrow = new Date(now + 86400_000).toDateString();
  if (day === today) return <>Today</>;
  if (day === tomorrow) return <>Tomorrow</>;
  return (
    <>
      {new Date(ms).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      })}
    </>
  );
}
