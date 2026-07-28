import Link from "next/link";
import CategoryGrid from "@/components/CategoryGrid";
import Onboarding from "@/components/Onboarding";
import StreakCard from "@/components/StreakCard";
import SyncBanner from "@/components/SyncBanner";
import { Card, Empty, Label, StatTile, TrendMark, VerdictBadge } from "@/components/ui";
import type { DayActivity } from "@/lib/queries";
import {
  getActivityStrip,
  getCategories,
  getCurrentUser,
  getNeedsReview,
  getOverview,
  getRecentSubmissions,
  getStreak,
  getSyncState,
  recommend,
} from "@/lib/queries";
import { daysAgo, masteryStep } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  let user;
  try {
    user = await getCurrentUser();
  } catch {
    return (
      <div className="mt-16">
        <Empty title="Can't reach the database">
          Postgres isn&apos;t answering. Start it with{" "}
          <code className="num">docker start cp-trainer-pg</code> and reload.
        </Empty>
      </div>
    );
  }
  if (!user) return <Onboarding />;

  const [sync, categories, overview, review, recent, activity, rec, streak] =
    await Promise.all([
      getSyncState(user.id),
      getCategories(user.id),
      getOverview(user.id),
      getNeedsReview(user.id),
      getRecentSubmissions(user.id, 8),
      getActivityStrip(user.id),
      recommend(user.id, null).catch(() => null),
      getStreak(user.id),
    ]);

  const hasData = overview.submissions_total > 0;

  return (
    <div className="pt-6">
      {sync?.status === "running" && (
        <SyncBanner initialCount={sync.submissions_total} />
      )}
      {sync?.status === "error" && (
        <div className="mb-4 rounded-(--radius-card) border border-line bg-card px-4 py-3 text-sm">
          <span className="font-medium text-wa">Sync failed:</span>{" "}
          <span className="text-muted">{sync.message}</span>{" "}
          <Link href="/settings" className="text-accent underline underline-offset-2">
            Retry in settings
          </Link>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">
            Mastery
          </h1>
          <p className="mt-1 text-sm text-muted">
            Eight areas, one score each — 100 means on fire right now. Scores
            cool after a month away.
          </p>
        </div>
        <Link
          href="/solve"
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90"
        >
          Start practicing
        </Link>
      </div>

      {!hasData ? (
        <Card className="mb-4">
          <Empty title="Waiting for your history">
            Once your submissions are mirrored, each area gets a strength
            estimate and a heat score here.
          </Empty>
        </Card>
      ) : (
        <div className="mb-4">
          <CategoryGrid categories={categories} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <Label>Practice next</Label>
            {rec ? (
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{rec.title}</span>
                  <span className="num shrink-0 text-sm text-muted">
                    {rec.rating ?? "—"}
                  </span>
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                  {rec.why}
                </p>
                <Link
                  href={`/solve?topic=${rec.topic_slug}`}
                  className="mt-3 inline-block rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink hover:opacity-90"
                >
                  Start problem
                </Link>
              </div>
            ) : (
              <p className="text-sm text-muted">
                Recommendations appear once your first sync lands.
              </p>
            )}
          </Card>

          <Card>
            <Label>Recent submissions</Label>
            {recent.length === 0 ? (
              <p className="text-sm text-muted">
                Nothing mirrored yet — submissions land here after each sync.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {recent.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 py-2.5">
                    <VerdictBadge verdict={s.verdict} />
                    <a
                      href={s.url ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 truncate text-sm hover:text-accent"
                    >
                      {s.title ?? "Unknown problem"}
                    </a>
                    <span className="num hidden text-xs text-muted sm:block">
                      {s.rating ?? ""}
                    </span>
                    <span className="num w-20 text-right text-xs text-muted">
                      {daysAgo(s.submitted_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <StatTile
              label="CF rating"
              value={user.cf_rating ?? "—"}
              sub={user.cf_rank ?? "unrated"}
            />
            <StatTile
              label="Solved · 30d"
              value={overview.solved_30d}
              sub={`${overview.solved_total} all time`}
            />
          </div>

          <Card>
            <Label>Needs review</Label>
            {review.length === 0 ? (
              <p className="text-sm text-muted">
                Nothing is weak or stale right now. Keep the streak.
              </p>
            ) : (
              <ul className="flex flex-col">
                {review.map((r) => (
                  <li key={r.slug}>
                    <Link
                      href={`/topics/${r.slug}`}
                      className="-mx-2 flex items-center justify-between gap-2 rounded-lg px-2 py-2 hover:bg-card-2"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="size-2.5 shrink-0 rounded-[3px]"
                          style={{ backgroundColor: `var(--m${masteryStep(r.score)})` }}
                        />
                        <span className="truncate text-sm">{r.name}</span>
                        <TrendMark trend={r.trend} />
                      </span>
                      <span className="num shrink-0 text-xs text-muted">
                        {r.reason.includes("stale")
                          ? daysAgo(r.last_practiced_at)
                          : `score ${Math.round(r.score ?? 0)}`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <StreakCard streak={streak} activity={activity} />

          <Card>
            <Label>Last 8 weeks</Label>
            <ActivityStrip days={activity} />
          </Card>
        </div>
      </div>
    </div>
  );
}

function ActivityStrip({ days }: { days: DayActivity[] }) {
  const max = Math.max(1, ...days.map((d) => d.solved + d.failed));
  // Square-root scale: one 40-submission day would otherwise flatten every
  // ordinary day into an indistinguishable line.
  const scale = (n: number) => Math.sqrt(n) / Math.sqrt(max);
  const busiest = days.reduce(
    (best, d) => (d.solved + d.failed > best.solved + best.failed ? d : best),
    days[0],
  );

  return (
    <>
      <div
        className="flex h-16 items-end gap-[2px]"
        aria-label="Daily submissions, last 8 weeks"
      >
        {days.map((d) => {
          const total = d.solved + d.failed;
          return (
            <div
              key={d.day}
              title={`${d.day}: ${d.solved} solved, ${d.failed} failed`}
              className="flex-1 rounded-[2px]"
              style={{
                height: total === 0 ? "4px" : `${Math.max(10, scale(total) * 100)}%`,
                backgroundColor: total === 0 ? "var(--m0)" : "var(--accent)",
              }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted">
        <span>8 weeks ago</span>
        <span className="num">
          busiest {busiest ? busiest.solved + busiest.failed : 0}/day
        </span>
      </div>
    </>
  );
}
