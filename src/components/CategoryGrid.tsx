import Link from "next/link";
import type { CategoryMastery } from "@/lib/queries";
import { categoryColor, daysAgo, heatLabel } from "@/lib/taxonomy";
import { TrendMark } from "./ui";

/*
  The hero: 8 major ICPC areas, one comprehensive score each (current heat,
  0–100). Each card carries its category's identity color; clicking one opens
  the category's own practice page in that theme.
*/

export default function CategoryGrid({
  categories,
}: {
  categories: CategoryMastery[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {categories.map((c) => {
        const color = categoryColor(c.slug);
        const score = c.score != null ? Math.round(c.score) : null;
        return (
          <Link
            key={c.slug}
            href={`/categories/${c.slug.replace(/^cat-/, "")}`}
            style={
              {
                "--cat": color,
                backgroundImage:
                  "linear-gradient(color-mix(in oklab, var(--cat) 7%, transparent), transparent 55%)",
              } as React.CSSProperties
            }
            className="group relative overflow-hidden rounded-(--radius-card) border border-line bg-card p-4 transition-colors hover:border-(--cat)/60"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 rounded-[4px]"
                style={{ backgroundColor: color }}
              />
              <span className="truncate text-[13px] font-semibold">{c.name}</span>
            </div>

            <div className="mt-3 flex items-baseline gap-2">
              <span
                className="num text-[34px] font-bold leading-none"
                style={{ color }}
              >
                {score ?? "—"}
              </span>
              <span className="text-xs text-muted">{heatLabel(c.score)}</span>
              <TrendMark trend={c.trend} />
            </div>

            <div className="num mt-2.5 text-[11px] text-muted">
              {c.rating_estimate != null ? (
                <>
                  est {Math.round(c.rating_estimate)} · {c.solved_count} solved ·{" "}
                  {daysAgo(c.last_practiced_at)}
                </>
              ) : (
                "no rated solves yet"
              )}
            </div>

            {/* heat bar — encodes the score, in the category's color */}
            <div className="mt-3 h-1 rounded-full bg-card-2">
              <div
                className="h-full rounded-full"
                style={{ width: `${score ?? 0}%`, backgroundColor: color }}
              />
            </div>

            {c.stale_modules > 0 && (
              <div className="mt-2 text-[11px] text-muted">
                {c.stale_modules === 1
                  ? "1 topic needs review"
                  : `${c.stale_modules} topics need review`}
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
