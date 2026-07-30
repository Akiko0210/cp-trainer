import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, Empty, Label, TrendMark } from "@/components/ui";
import {
  getCategoryModules,
  getCurrentUser,
  getTopicDetail,
  getUnsolvedInTopic,
} from "@/lib/queries";
import {
  CATEGORIES,
  categoryColor,
  daysAgo,
  heatLabel,
  TIERS,
} from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

/*
  One category, in its own theme color: the comprehensive score with its
  anatomy (level × evidence × freshness — no black box), the module ladder
  by tier, and everything needed to practice exactly this area.
*/
export default async function CategoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const meta = CATEGORIES.find((c) => c.slug === slug);
  if (!meta) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const catSlug = `cat-${slug}`;
  const topic = await getTopicDetail(user.id, catSlug);
  if (!topic) notFound();

  const target = Math.round(topic.rating_estimate ?? user.cf_rating ?? 1200) + 150;
  const [modules, unsolved] = await Promise.all([
    getCategoryModules(user.id, catSlug),
    getUnsolvedInTopic(user.id, topic.id, target),
  ]);

  const color = categoryColor(slug);
  const score = topic.score != null ? Math.round(topic.score) : null;
  // The worker stores the factors it actually multiplied; never re-derive.
  const anatomy = topic.factors?.level != null ? topic.factors : null;
  const all = topic.contributors ?? [];
  const contributors = all.slice(0, 10);
  const shownPush = contributors.reduce((s, c) => s + c.push, 0);
  const tailPush = (topic.factors?.push_total ?? 0) - shownPush;

  const tiers = Object.entries(TIERS)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([division, t]) => ({
      ...t,
      division,
      modules: modules.filter((m) => m.division === division),
    }))
    .filter((t) => t.modules.length > 0);

  return (
    <div className="pt-6" style={{ "--cat": color } as React.CSSProperties}>
      <nav className="mb-4 text-sm text-muted" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-ink">
          Mastery
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink">{meta.name}</span>
      </nav>

      {/* header band in the category's color */}
      <div
        className="mb-4 rounded-(--radius-card) border border-line p-6"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in oklab, var(--cat) 10%, transparent), color-mix(in oklab, var(--cat) 3%, transparent))",
        }}
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              {meta.blurb}
            </div>
            <h1 className="font-display mt-1 text-[30px] font-semibold tracking-tight">
              {meta.name}
            </h1>
            <div className="mt-3 flex items-baseline gap-3">
              <span
                className="num text-[44px] font-bold leading-none"
                style={{ color }}
              >
                {score ?? "—"}
              </span>
              <span className="text-sm text-muted">
                {heatLabel(topic.score)}
                {topic.rating_estimate != null && (
                  <>
                    {" "}
                    · est{" "}
                    <span className="num">{Math.round(topic.rating_estimate)}</span>
                    {topic.estimate_se != null && (
                      <span className="num text-muted/70">
                        {" "}
                        ±{Math.round(topic.estimate_se)}
                      </span>
                    )}
                  </>
                )}
                <TrendMark trend={topic.trend} />
              </span>
            </div>
          </div>
          <Link
            href={`/solve?topic=${catSlug}`}
            className="rounded-xl px-5 py-3 text-sm font-semibold text-white hover:opacity-90"
            style={{ backgroundColor: color }}
          >
            Grind {meta.name}
          </Link>
        </div>

        {anatomy && (
          <div className="num mt-5 flex flex-wrap gap-x-6 gap-y-1 border-t border-line/70 pt-4 text-xs text-muted">
            <span>
              level <b className="text-ink">{Math.round(anatomy.level)}</b>
              <span className="font-sans">
                {" "}
                (est vs your overall {Math.round(
                  anatomy.your_level - anatomy.selection_offset,
                )})
              </span>
            </span>
            <span aria-hidden>×</span>
            <span>
              evidence <b className="text-ink">{anatomy.evidence.toFixed(2)}</b>
              <span className="font-sans">
                {" "}
                ({topic.recent_solve_count ?? 0} solves in 90d)
              </span>
            </span>
            <span aria-hidden>×</span>
            <span>
              freshness <b className="text-ink">{anatomy.freshness.toFixed(2)}</b>
              <span className="font-sans">
                {" "}
                {anatomy.idle_days != null && anatomy.idle_days > 30
                  ? `(decaying — ${Math.round(anatomy.idle_days)}d since you touched it)`
                  : "(fresh)"}
              </span>
            </span>
            <span aria-hidden>=</span>
            <span>
              score <b style={{ color }}>{score}</b>
            </span>
          </div>
        )}
      </div>

      {/* tier ladder */}
      <Card className="mb-4">
        <Label>The ladder · Basics → Expert</Label>
        <div className="flex flex-col gap-4">
          {tiers.map((t) => (
            <div key={t.label}>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  {t.label}
                </span>
                <span className="num text-xs text-muted/70">
                  {t.modules.filter((m) => m.score != null).length}/{t.modules.length}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {t.modules.map((m) => {
                  const s = m.score != null ? Math.round(m.score) : null;
                  const pct = s == null ? 7 : s < 20 ? 16 : s < 40 ? 32 : s < 60 ? 52 : s < 80 ? 74 : 100;
                  const needsReview = !!m.stale && (m.solved_count ?? 0) > 0;
                  return (
                    <Link
                      key={m.slug}
                      href={`/topics/${m.slug}`}
                      title={`${m.name} — ${heatLabel(m.score)}${m.last_practiced_at ? `, last solve ${daysAgo(m.last_practiced_at)}` : ""}`}
                      className={`flex items-center gap-1.5 rounded-(--radius-chip) px-2.5 py-1.5 text-[13px] leading-none transition-transform hover:scale-[1.04] ${
                        needsReview
                          ? "outline-1 outline-dashed outline-offset-2 outline-current/60"
                          : ""
                      }`}
                      style={{
                        backgroundColor: `color-mix(in oklab, var(--cat) ${pct}%, var(--card-2))`,
                        color: pct > 40 ? "#fff" : "var(--ink)",
                      }}
                    >
                      <span className="max-w-[22ch] truncate">{m.name}</span>
                      {s != null && (
                        <span className="num text-[11px] font-semibold opacity-85">{s}</span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
          Chip depth = module heat in this category&apos;s color · dashed = 45+
          days idle, due for review.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Label>What&apos;s behind the estimate</Label>
          {contributors.length === 0 || !anatomy ? (
            <Empty title="Nothing to fit here yet">
              Solve or attempt one problem in this area and the estimate starts
              moving.
            </Empty>
          ) : (
            <>
              <p className="mb-1 text-[13px] leading-relaxed text-muted">
                Fitted from the <span className="num">{anatomy.n_obs}</span>{" "}
                problems you&apos;ve engaged with here —{" "}
                <span className="num">{anatomy.n_solved}</span> solved,{" "}
                <span className="num">{anatomy.n_obs - anatomy.n_solved}</span>{" "}
                not. Failures count: they&apos;re what stops the estimate running
                away above what you can actually clear.
              </p>
              <p className="mb-3 text-[13px] leading-relaxed text-muted">
                <b className="font-medium text-ink">Push</b> is how far each
                outcome moved the fit — clearing something you were expected to
                fail pushes up, failing something you were expected to clear
                pushes down. The estimate sits where they balance.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                      <th className="pb-2 pr-2 text-left font-semibold">Problem</th>
                      <th className="num pb-2 px-2 text-right font-semibold">Diff</th>
                      <th className="num pb-2 px-2 text-right font-semibold">Exp.</th>
                      <th className="num pb-2 px-2 text-right font-semibold">Got</th>
                      <th className="num pb-2 pl-2 text-right font-semibold">Push</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {contributors.map((c) => (
                      <tr key={c.problem_id}>
                        <td className="max-w-40 truncate py-2 pr-2">
                          <a
                            href={c.url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-accent"
                            title={`${c.title} · ${daysAgo(c.at)}${
                              c.in_contest ? " · in contest" : " · practice"
                            }`}
                          >
                            {c.title}
                          </a>
                        </td>
                        <td
                          className="num px-2 py-2 text-right text-muted"
                          title={
                            c.effective_difficulty !== c.rating
                              ? `rated ${c.rating}, counted as ${c.effective_difficulty} (${
                                  c.solved && !c.in_contest
                                    ? "practice discount"
                                    : c.wa_count === 0
                                      ? "clean solve"
                                      : `${c.wa_count} wrong submissions`
                                })`
                              : undefined
                          }
                        >
                          {c.effective_difficulty}
                        </td>
                        <td className="num px-2 py-2 text-right text-muted">
                          {Math.round(c.p_solve * 100)}%
                        </td>
                        <td className="num px-2 py-2 text-right">
                          <span className={c.solved ? "text-ac" : "text-wa"}>
                            {c.solved ? "AC" : "—"}
                          </span>
                        </td>
                        <td
                          className={`num py-2 pl-2 text-right ${
                            c.push > 0 ? "text-ink" : "text-muted"
                          }`}
                        >
                          {c.push > 0 ? "+" : ""}
                          {c.push.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-line">
                    {all.length > contributors.length && (
                      <tr className="text-xs text-muted">
                        <td className="py-2 pr-2 font-sans" colSpan={4}>
                          + {all.length - contributors.length} smaller
                          observations
                          {anatomy.n_obs > all.length &&
                            ` (of ${anatomy.n_obs} total)`}
                        </td>
                        <td className="num py-2 pl-2 text-right">
                          {tailPush > 0 ? "+" : ""}
                          {tailPush.toFixed(2)}
                        </td>
                      </tr>
                    )}
                    <tr className="text-xs">
                      <td className="py-2 pr-2 font-sans text-muted" colSpan={4}>
                        Net push, balanced against the pull toward your overall
                        level
                      </td>
                      <td className="num py-2 pl-2 text-right font-semibold">
                        {anatomy.push_total > 0 ? "+" : ""}
                        {anatomy.push_total.toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted">
                The raw fit lands at{" "}
                <span className="num">{Math.round(anatomy.theta_engaged)}</span>;
                we subtract{" "}
                <span className="num">{Math.round(anatomy.selection_offset)}</span>{" "}
                because you pick your own problems, which inflates every
                estimate by that much measured against your contest record.
              </p>
            </>
          )}
        </Card>

        <Card>
          <Label>Unsolved · near your level</Label>
          {unsolved.length === 0 ? (
            <Empty title="Nothing left in the catalog here" />
          ) : (
            <ul className="divide-y divide-line">
              {unsolved.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2.5">
                  <span className="num w-11 shrink-0 text-right text-xs text-muted">
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
                      className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                      style={{ backgroundColor: color }}
                      title="Hand-picked by usaco.guide"
                    >
                      curated
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
