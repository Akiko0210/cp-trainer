import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, Empty, Label } from "@/components/ui";
import {
  getContestSets,
  getOpenSession,
  getPastSessions,
  getSetFilterOptions,
} from "@/lib/icpc-queries";
import { getCurrentUser } from "@/lib/queries";
import { daysAgo, fmtDuration } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  "world-finals": "World Finals",
  regional: "Regionals",
  qualifier: "Qualifiers",
  practice: "Practice sessions",
  other: "Other",
};
const KIND_ORDER = ["world-finals", "regional", "qualifier", "practice", "other"];

export default async function IcpcPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; year?: string; region?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  const sp = await searchParams;
  const year = sp.year ? Number(sp.year) : undefined;

  const [sets, options, open, past] = await Promise.all([
    getContestSets(user.id, { kind: sp.kind, region: sp.region, year }),
    getSetFilterOptions(),
    getOpenSession(user.id),
    getPastSessions(user.id, 5),
  ]);

  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind] ?? kind,
    sets: sets.filter((s) => s.kind === kind),
  })).filter((g) => g.sets.length > 0);

  return (
    <div className="pt-6" style={{ "--accent-local": "var(--icpc)" } as React.CSSProperties}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">
            ICPC practice
          </h1>
          <p className="mt-1 text-sm text-muted">
            Real regional and World Finals problem sets. Run one as a virtual
            contest — five hours, one clock, the whole set.
          </p>
        </div>
      </div>

      {open && (
        <Link
          href={`/icpc/${open.set_slug}`}
          className="mb-4 flex flex-wrap items-center gap-3 rounded-(--radius-card) border p-4 text-sm"
          style={{
            borderColor: "var(--icpc)",
            backgroundColor: "var(--icpc-soft)",
          }}
        >
          <span className="relative flex size-2.5">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
              style={{ backgroundColor: "var(--icpc)" }}
            />
            <span
              className="relative inline-flex size-2.5 rounded-full"
              style={{ backgroundColor: "var(--icpc)" }}
            />
          </span>
          <span className="font-medium">Contest in progress — {open.set_name}</span>
          <span className="num ml-auto text-muted">
            {fmtDuration(open.duration_s)} on the clock →
          </span>
        </Link>
      )}

      {/* filters: one row, above the list */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5 text-sm">
        <FilterChip href="/icpc" active={!sp.kind && !year && !sp.region}>
          All {sets.length > 0 && !sp.kind && !year && !sp.region ? sets.length : ""}
        </FilterChip>
        {options.kinds
          .filter((k) => KIND_LABELS[k.kind])
          .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
          .map((k) => (
            <FilterChip
              key={k.kind}
              href={`/icpc?kind=${k.kind}`}
              active={sp.kind === k.kind}
            >
              {KIND_LABELS[k.kind]} <span className="num opacity-60">{k.n}</span>
            </FilterChip>
          ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <form action="/icpc" className="flex items-center gap-1.5">
          {sp.kind && <input type="hidden" name="kind" value={sp.kind} />}
          <label htmlFor="year" className="sr-only">
            Year
          </label>
          <select
            id="year"
            name="year"
            defaultValue={year ?? ""}
            className="rounded-(--radius-chip) border border-line bg-card px-2.5 py-1.5 text-sm"
          >
            <option value="">Any year</option>
            {options.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <label htmlFor="region" className="sr-only">
            Region
          </label>
          <select
            id="region"
            name="region"
            defaultValue={sp.region ?? ""}
            className="max-w-44 rounded-(--radius-chip) border border-line bg-card px-2.5 py-1.5 text-sm"
          >
            <option value="">Any region</option>
            {options.regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-(--radius-chip) border border-line px-3 py-1.5 text-sm hover:border-accent/50"
          >
            Filter
          </button>
        </form>
      </div>

      {sets.length === 0 ? (
        <Card>
          <Empty title="No sets match that filter">
            Try a wider filter, or refresh the archive from{" "}
            <Link href="/settings" className="text-accent underline underline-offset-2">
              settings
            </Link>
            .
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map((g) => (
            <Card key={g.kind}>
              <Label>
                {g.label} · <span className="num">{g.sets.length}</span>
              </Label>
              <ul className="divide-y divide-line">
                {g.sets.map((s) => {
                  const pct =
                    s.problem_count > 0
                      ? (s.solved_count / s.problem_count) * 100
                      : 0;
                  return (
                    <li key={s.id}>
                      <Link
                        href={`/icpc/${encodeURIComponent(s.slug)}`}
                        className="-mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2.5 hover:bg-card-2"
                      >
                        <span className="num w-10 shrink-0 text-xs text-muted">
                          {s.year ?? "—"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {s.name}
                        </span>
                        {s.min_difficulty != null && (
                          <span
                            className="num hidden shrink-0 text-xs text-muted sm:block"
                            title="Kattis difficulty range"
                          >
                            {s.min_difficulty.toFixed(1)}–
                            {s.max_difficulty?.toFixed(1)}
                          </span>
                        )}
                        <span className="flex shrink-0 items-center gap-2">
                          <span
                            className="h-1.5 w-16 overflow-hidden rounded-full bg-card-2"
                            aria-hidden
                          >
                            <span
                              className="block h-full rounded-full"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: "var(--icpc)",
                              }}
                            />
                          </span>
                          <span className="num w-12 text-right text-xs text-muted">
                            {s.solved_count}/{s.problem_count}
                          </span>
                        </span>
                        {s.last_session_at && (
                          <span className="num w-16 shrink-0 text-right text-xs text-muted">
                            {daysAgo(s.last_session_at)}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}

      {past.length > 0 && (
        <Card className="mt-4">
          <Label>Past contests</Label>
          <ul className="divide-y divide-line">
            {past.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2.5">
                <span className="num shrink-0 text-sm font-semibold">
                  {p.solved}/{p.attempted}
                </span>
                <Link
                  href={`/icpc/${encodeURIComponent(p.set_slug)}`}
                  className="min-w-0 flex-1 truncate text-sm hover:text-accent"
                >
                  {p.set_name}
                </Link>
                <span className="num w-20 text-right text-xs text-muted">
                  {daysAgo(p.started_at)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Solved / problems you opened during the contest.
          </p>
        </Card>
      )}
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`rounded-(--radius-chip) border px-3 py-1.5 transition-colors ${
        active ? "font-medium text-white" : "border-line text-muted hover:text-ink"
      }`}
      style={
        active
          ? { backgroundColor: "var(--icpc)", borderColor: "var(--icpc)" }
          : undefined
      }
    >
      {children}
    </Link>
  );
}
