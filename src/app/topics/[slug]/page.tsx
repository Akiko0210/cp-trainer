import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Empty, Label, TrendMark } from "@/components/ui";
import {
  getChildTopics,
  getCurrentUser,
  getTopicDetail,
  getUnsolvedInTopic,
} from "@/lib/queries";
import { CATEGORY_NAMES, daysAgo, heatLabel, masteryStep, TIERS } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

export default async function TopicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) notFound();
  const topic = await getTopicDetail(user.id, slug);
  if (!topic) notFound();

  const target =
    Math.round(topic.rating_estimate ?? user.cf_rating ?? 1200) + 150;
  const [children, unsolved] = await Promise.all([
    getChildTopics(user.id, topic.id),
    getUnsolvedInTopic(user.id, topic.id, target),
  ]);
  const contributors = topic.contributors ?? [];
  const step = masteryStep(topic.score);

  return (
    <div className="pt-6">
      <nav className="mb-4 text-sm text-muted" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-ink">
          Mastery
        </Link>
        <span className="mx-2">/</span>
        {topic.category_slug && (
          <>
            <Link
              href={`/categories/${topic.category_slug.replace(/^cat-/, "")}`}
              className="hover:text-ink"
            >
              {CATEGORY_NAMES[topic.category_slug.replace(/^cat-/, "")] ??
                topic.category_slug}
            </Link>
            <span className="mx-2">/</span>
          </>
        )}
        <span className="text-ink">{topic.name}</span>
      </nav>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            {TIERS[topic.division]?.label ?? topic.division}
          </div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">
            {topic.name}
          </h1>
        </div>
        <Link
          href={`/solve?topic=${topic.slug}`}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90"
        >
          Grind this topic
        </Link>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="!p-4">
          <Label>Score</Label>
          <div className="flex items-center gap-2.5">
            <span
              className="num grid h-9 min-w-9 place-items-center rounded-lg px-2 text-[15px] font-bold"
              style={{
                backgroundColor: `var(--m${step})`,
                color: `var(--m${step}-ink)`,
              }}
            >
              {topic.score != null ? Math.round(topic.score) : "—"}
            </span>
            <TrendMark trend={topic.trend} />
            <span className="text-xs text-muted">
              {topic.stale && (topic.solved_count ?? 0) > 0
                ? "needs review"
                : heatLabel(topic.score)}
            </span>
          </div>
        </Card>
        <Card className="!p-4">
          <Label>Estimate</Label>
          <div className="num text-[22px] font-semibold leading-9">
            {topic.rating_estimate != null ? Math.round(topic.rating_estimate) : "—"}
          </div>
        </Card>
        <Card className="!p-4">
          <Label>Confidence</Label>
          <div className="num text-[22px] font-semibold leading-9">
            {topic.confidence != null ? `${Math.round(topic.confidence * 100)}%` : "—"}
          </div>
        </Card>
        <Card className="!p-4">
          <Label>Last solve</Label>
          <div className="num text-[22px] font-semibold leading-9">
            {daysAgo(topic.last_practiced_at)}
          </div>
        </Card>
      </div>

      {children.length > 0 && (
        <Card className="mb-4">
          <Label>Modules in this chapter</Label>
          <div className="flex flex-wrap gap-1.5">
            {children.map((c) => {
              const s = masteryStep(c.score);
              return (
                <Link
                  key={c.slug}
                  href={`/topics/${c.slug}`}
                  className="flex items-center gap-1.5 rounded-(--radius-chip) px-2.5 py-1.5 text-[13px] leading-none transition-transform hover:scale-[1.04]"
                  style={{ backgroundColor: `var(--m${s})`, color: `var(--m${s}-ink)` }}
                >
                  <span>{c.name}</span>
                  {c.score != null && (
                    <span className="num text-[11px] font-semibold opacity-85">
                      {Math.round(c.score)}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Label>What&apos;s behind this score</Label>
          {contributors.length === 0 ? (
            <Empty title="No rated solves here yet">
              Solve a problem in this topic and it shows up here with the
              weight it carries.
            </Empty>
          ) : (
            <>
              <p className="mb-3 text-[13px] text-muted">
                Every problem you&apos;ve engaged with here, biggest movers
                first. <b className="font-medium text-ink">Push</b> is how far
                the outcome moved the estimate.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                      <th className="pb-2 pr-3 font-semibold">Problem</th>
                      <th className="num pb-2 pr-3 text-right font-semibold">Diff</th>
                      <th className="num pb-2 pr-3 text-right font-semibold">Exp.</th>
                      <th className="num pb-2 pr-3 text-right font-semibold">Got</th>
                      <th className="num pb-2 text-right font-semibold">Push</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {contributors.slice(0, 15).map((c) => (
                      <tr key={c.problem_id}>
                        <td className="max-w-48 truncate py-2 pr-3">
                          <a
                            href={c.url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-accent"
                          >
                            {c.title}
                          </a>
                        </td>
                        <td
                          className="num py-2 pr-3 text-right text-muted"
                          title={`rated ${c.rating} · ${daysAgo(c.at)} · ${
                            c.in_contest ? "in contest" : "practice"
                          }`}
                        >
                          {c.effective_difficulty}
                        </td>
                        <td className="num py-2 pr-3 text-right text-muted">
                          {Math.round(c.p_solve * 100)}%
                        </td>
                        <td className="num py-2 pr-3 text-right">
                          <span className={c.solved ? "text-ac" : "text-wa"}>
                            {c.solved ? "AC" : "—"}
                          </span>
                        </td>
                        <td
                          className={`num py-2 text-right ${
                            c.push > 0 ? "text-ink" : "text-muted"
                          }`}
                        >
                          {c.push > 0 ? "+" : ""}
                          {c.push.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>

        <Card>
          <Label>Unsolved here</Label>
          {unsolved.length === 0 ? (
            <Empty title="Nothing left in the catalog">
              You&apos;ve cleared the active problems for this topic.
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {unsolved.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2.5">
                  <span className="num w-12 shrink-0 text-right text-xs text-muted">
                    {p.rating ?? "—"}
                  </span>
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate text-sm hover:text-accent"
                  >
                    {p.title}
                  </a>
                  {p.curated && (
                    <span
                      className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-dk"
                      title="Hand-picked by usaco.guide for this topic"
                    >
                      curated
                    </span>
                  )}
                  {p.difficulty_label && (
                    <span className="hidden text-xs text-muted sm:block">
                      {p.difficulty_label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
