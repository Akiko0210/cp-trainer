import Link from "next/link";
import { redirect } from "next/navigation";
import { TagLegend, TagTrendChart, VerdictMixChart } from "@/components/MistakeCharts";
import { Card, Empty, Label, VerdictBadge } from "@/components/ui";
import {
  getFailByTopic,
  getHeadline,
  getRecentPostMortems,
  getTagCounts,
  getTagTopicMatrix,
  getTagTrend,
  getVerdictTrend,
} from "@/lib/mistake-queries";
import { getCurrentUser } from "@/lib/queries";
import { daysAgo, MISTAKE_LABELS } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

export default async function MistakesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const [headline, tagCounts, matrix, trend, verdictTrend, failTopics, recent] =
    await Promise.all([
      getHeadline(user.id),
      getTagCounts(user.id),
      getTagTopicMatrix(user.id),
      getTagTrend(user.id),
      getVerdictTrend(user.id),
      getFailByTopic(user.id),
      getRecentPostMortems(user.id),
    ]);

  const hasTags = tagCounts.length > 0;
  const topTags = tagCounts.slice(0, 5).map((t) => t.tag);

  // pivot trend rows -> one object per week for the chart
  const weeks = [...new Set(trend.map((t) => t.week))].sort();
  const trendData = weeks.map((week) => {
    const row: Record<string, string | number> = { week };
    for (const tag of topTags) row[tag] = 0;
    for (const t of trend) if (t.week === week) row[t.tag] = t.n;
    return row;
  });

  const chapters = [...new Set(matrix.map((m) => m.chapter))];
  const matrixMax = Math.max(1, ...matrix.map((m) => m.n));

  return (
    <div className="pt-6">
      <div className="mb-5">
        <h1 className="font-display text-[26px] font-semibold tracking-tight">
          Mistake patterns
        </h1>
        <p className="mt-1 text-sm text-muted">
          What keeps going wrong, where it concentrates, and whether it&apos;s
          improving.
        </p>
      </div>

      {headline && (
        <div className="mb-4 rounded-(--radius-card) border border-line bg-accent-soft p-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-dk">
            This month
          </div>
          <p className="font-display mt-1.5 text-xl font-semibold leading-snug">
            {Math.round(headline.share * 100)}% of your tagged mistakes are{" "}
            {(MISTAKE_LABELS[headline.tag] ?? headline.tag).toLowerCase()}
            {headline.top_chapter && headline.chapter_share != null && headline.chapter_share >= 0.4
              ? `, concentrated in ${headline.top_chapter}`
              : ""}
            .
          </p>
        </div>
      )}

      {!hasTags && (
        <div className="mb-4">
          <Empty
            title="No tagged mistakes yet"
            action={
              <Link
                href="/solve"
                className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90"
              >
                Start a timed solve
              </Link>
            }
          >
            After a failed or messy solve in the Solve view, tag what went wrong
            — one tap. Those tags build this page. The judge-side stats below
            already work from your mirrored history.
          </Empty>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {hasTags && (
          <Card>
            <Label>Top mistake types</Label>
            <ul className="flex flex-col gap-2.5">
              {tagCounts.map((t) => {
                const max = tagCounts[0].n;
                return (
                  <li key={t.tag} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-sm">
                      {MISTAKE_LABELS[t.tag] ?? t.tag}
                    </span>
                    <div className="h-4 flex-1 rounded-[4px] bg-card-2">
                      <div
                        className="h-full rounded-[4px] bg-accent"
                        style={{ width: `${(t.n / max) * 100}%` }}
                      />
                    </div>
                    <span className="num w-14 shrink-0 text-right text-xs text-muted">
                      {t.n}
                      {t.n30 > 0 && <span className="text-accent"> +{t.n30}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-muted">
              All time; <span className="text-accent">+n</span> = last 30 days.
            </p>
          </Card>
        )}

        {hasTags && trendData.length >= 2 && (
          <Card>
            <Label>Trend · weekly, top {topTags.length} types</Label>
            <TagTrendChart data={trendData} tags={topTags} />
            <TagLegend tags={topTags} />
          </Card>
        )}

        {hasTags && matrix.length > 0 && (
          <Card className="lg:col-span-2">
            <Label>Where each mistake type concentrates</Label>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                    <th className="pb-2 pr-3 font-semibold">Type</th>
                    {chapters.map((c) => (
                      <th key={c} className="pb-2 pr-2 text-center font-semibold">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...new Set(matrix.map((m) => m.tag))].map((tag) => (
                    <tr key={tag} className="border-t border-line">
                      <td className="py-1.5 pr-3">{MISTAKE_LABELS[tag] ?? tag}</td>
                      {chapters.map((c) => {
                        const cell = matrix.find((m) => m.tag === tag && m.chapter === c);
                        const n = cell?.n ?? 0;
                        const step = n === 0 ? 0 : Math.min(5, Math.ceil((n / matrixMax) * 5));
                        return (
                          <td key={c} className="px-1 py-1.5 text-center">
                            <span
                              className="num inline-block w-9 rounded-md py-1 text-xs"
                              style={{
                                backgroundColor: `var(--m${step})`,
                                color: `var(--m${step}-ink)`,
                              }}
                            >
                              {n || ""}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted">
              Grouped by Codeforces topic, so mistakes from ICPC sets are
              counted in the totals above but not placed here — Kattis problems
              carry no topic tags.
            </p>
          </Card>
        )}

        <Card>
          <Label>Verdict mix · judge history, 6 months</Label>
          {verdictTrend.length === 0 ? (
            <p className="text-sm text-muted">No mirrored submissions yet.</p>
          ) : (
            <>
              <VerdictMixChart data={verdictTrend} />
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[3px] bg-ac" /> AC
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[3px] bg-wa" /> WA
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[3px] bg-tle" /> TLE/MLE
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[3px] bg-rece" /> RE/CE/other
                </span>
              </div>
            </>
          )}
        </Card>

        <Card>
          <Label>Highest fail rate · 30 days</Label>
          {failTopics.length === 0 ? (
            <p className="text-sm text-muted">
              Not enough recent submissions to rank topics (needs 5+ per topic).
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {failTopics.map((t) => (
                <li key={t.slug} className="flex items-center gap-3">
                  <Link
                    href={`/categories/${t.slug}`}
                    className="w-40 shrink-0 truncate text-sm hover:text-accent"
                  >
                    {t.chapter}
                  </Link>
                  <div className="h-4 flex-1 rounded-[4px] bg-card-2">
                    <div
                      className="h-full rounded-[4px] bg-wa/80"
                      style={{ width: `${(t.fails / t.total) * 100}%` }}
                      title={`${t.fails} failed of ${t.total}`}
                    />
                  </div>
                  <span className="num w-16 shrink-0 text-right text-xs text-muted">
                    {Math.round((t.fails / t.total) * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {recent.length > 0 && (
        <Card className="mt-4">
          <Label>Recent post-mortems</Label>
          <ul className="divide-y divide-line">
            {recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <VerdictBadge verdict={a.outcome === "ac" ? "OK" : "WRONG_ANSWER"} />
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-sm hover:text-accent"
                >
                  {a.title}
                </a>
                <span className="flex flex-wrap gap-1">
                  {a.tags.map((t, i) => (
                    <span
                      key={i}
                      className="rounded-md bg-card-2 px-1.5 py-0.5 text-[11px] text-muted"
                    >
                      {MISTAKE_LABELS[t] ?? t}
                    </span>
                  ))}
                </span>
                <span className="num w-20 text-right text-xs text-muted">
                  {daysAgo(a.started_at)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
