"use client";

import Link from "next/link";
import LocalTime from "./LocalTime";
import {
  countdown,
  durationLabel,
  PlatformMark,
  ReminderToggle,
  useContestReminders,
  useNowMs,
} from "./contest-ui";
import { Card, Label } from "./ui";
import type { UpcomingContest } from "@/lib/queries";

/*
  The next few rounds across judges, on the dashboard.

  Kept to one glanceable line per contest: the mark carries the platform (so
  the name doesn't have to repeat it), and the second line is the only thing a
  reader actually plans around — when it starts, and how long it runs. The
  full board with filters is one click away at /contests.

  The data is the worker's per-judge calendar mirror (worker/contests.py) read
  from Postgres; this component never talks to a judge. What the browser adds
  is the two things only it can know: the viewer's timezone, and whether the
  viewer wants to be interrupted.

  Colour: the near-start highlight is the accent, deliberately not amber —
  amber means TLE here and nothing else (AGENTS.md).
*/

export default function UpcomingContests({
  contests,
  workerConfigured,
}: {
  contests: UpcomingContest[];
  workerConfigured: boolean;
}) {
  const now = useNowMs();
  const reminders = useContestReminders(contests);

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <Label>Upcoming contests</Label>
        <div className="mb-3 flex items-center gap-2">
          <ReminderToggle {...reminders} />
          <Link
            href="/contests"
            className="text-[11px] font-medium text-muted hover:text-accent"
          >
            All →
          </Link>
        </div>
      </div>

      {contests.length === 0 ? (
        <p className="text-sm text-muted">
          {workerConfigured
            ? "Nothing scheduled right now."
            : "The worker mirrors the judges' calendars — without one this stays empty."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {contests.map((c) => {
            const msLeft = now === null ? null : c.starts_at_ms - now;
            const soon = msLeft !== null && msLeft < 60 * 60 * 1000;
            const iso = new Date(c.starts_at_ms).toISOString();
            return (
              <li key={c.id}>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-card-2"
                >
                  <PlatformMark platform={c.platform} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-tight">
                      {c.name}
                    </span>
                    <span className="num mt-0.5 block text-[11px] leading-tight text-muted">
                      <LocalTime iso={iso} mode="daytime" /> ·{" "}
                      {durationLabel(c.duration_s)}
                    </span>
                  </span>
                  {msLeft !== null && (
                    <span
                      className={`num shrink-0 text-[11px] ${
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
      )}
    </Card>
  );
}
