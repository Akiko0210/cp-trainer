import Link from "next/link";
import { redirect } from "next/navigation";
import IcpcFilters from "./IcpcFilters";
import { Card, Empty, Label } from "@/components/ui";
import {
  getContestSets,
  getLadder,
  getOpenSession,
  getPastSessions,
  getSetFilterOptions,
  type ContestSet,
} from "@/lib/icpc-queries";
import { getCurrentUser } from "@/lib/queries";
import { daysAgo, fmtDuration, ICPC_LEVELS, LEVEL_ORDER } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

// Regions in the order a North American competitor cares about them.
const REGION_ORDER = ["North America", "Europe", "Asia", "Global", "Other"];

export default async function IcpcPage({
  searchParams,
}: {
  searchParams: Promise<{
    level?: string;
    year?: string;
    region?: string;
    series?: string;
  }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const sp = await searchParams;
  const year = sp.year ? Number(sp.year) : undefined;

  const [sets, options, open, past, ladder] = await Promise.all([
    getContestSets(user.id, {
      level: sp.level,
      region: sp.region,
      series: sp.series,
      year,
    }),
    getSetFilterOptions(),
    getOpenSession(user.id),
    getPastSessions(user.id, 5),
    getLadder(user.id),
  ]);

  // Level → region → series, so "Pacific Northwest" and "Mid-Central" stay
  // distinct instead of collapsing into one pile of regionals.
  const byLevel = LEVEL_ORDER.map((level) => {
    const inLevel = sets.filter((s) => s.level === level);
    const regions = REGION_ORDER.map((region) => {
      const inRegion = inLevel.filter((s) => (s.region ?? "Other") === region);
      const seriesNames = [...new Set(inRegion.map((s) => s.series ?? "Other"))].sort();
      return {
        region,
        total: inRegion.length,
        series: seriesNames.map((name) => ({
          name,
          sets: inRegion.filter((s) => (s.series ?? "Other") === name),
        })),
      };
    }).filter((r) => r.total > 0);
    return { level, meta: ICPC_LEVELS[level], total: inLevel.length, regions };
  }).filter((l) => l.total > 0);

  const filtered = !!(sp.level || sp.region || sp.series || year);

  return (
    <div className="pt-6">
      <div className="mb-5">
        <h1 className="font-display text-[26px] font-semibold tracking-tight">
          ICPC practice
        </h1>
        <p className="mt-1 text-sm text-muted">
          Real problem sets from every rung of the ladder. Run one as a virtual
          contest — one clock, the whole set.
        </p>
      </div>

      {open && (
        <Link
          href={`/icpc/${encodeURIComponent(open.set_slug)}`}
          className="mb-4 flex flex-wrap items-center gap-3 rounded-(--radius-card) border p-4 text-sm"
          style={{ borderColor: "var(--icpc)", backgroundColor: "var(--icpc-soft)" }}
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

      <Ladder ladder={ladder} activeLevel={sp.level} />

      <IcpcFilters options={options} current={{ ...sp, year }} />

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
          {byLevel.map((lvl) => (
            <Card key={lvl.level}>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="font-display text-[15px] font-semibold">
                  {lvl.meta?.label ?? lvl.level}
                </h2>
                <span className="num text-xs text-muted">{lvl.total}</span>
                <span className="text-xs text-muted">{lvl.meta?.blurb}</span>
              </div>

              <div className="flex flex-col gap-4">
                {lvl.regions.map((r) => (
                  <div key={r.region}>
                    {/* Only label the region when the level spans more than one */}
                    {lvl.regions.length > 1 && (
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                        {r.region}
                      </div>
                    )}
                    <div className="flex flex-col gap-3">
                      {r.series.map((s) => (
                        <div key={s.name}>
                          {/* A single unnamed series adds no information */}
                          {!(r.series.length === 1 && s.sets.length === lvl.total) && (
                            <div className="mb-0.5 flex items-baseline gap-2">
                              <span className="text-[13px] font-medium">
                                {s.name}
                              </span>
                              <span className="num text-[11px] text-muted">
                                {s.sets.length}
                              </span>
                            </div>
                          )}
                          <ul className="divide-y divide-line">
                            {s.sets.map((set) => (
                              <SetRow key={set.id} set={set} />
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {past.length > 0 && !filtered && (
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

/* One row per set. Fixed column widths so every row lines up whether or not
   it has a difficulty range or a past session. */
function SetRow({ set }: { set: ContestSet }) {
  const pct =
    set.problem_count > 0 ? (set.solved_count / set.problem_count) * 100 : 0;
  const started = set.sessions > 0;
  return (
    <li>
      <Link
        href={`/icpc/${encodeURIComponent(set.slug)}`}
        className="-mx-2 grid grid-cols-[2.5rem_1fr_auto] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2.5 hover:bg-card-2 sm:grid-cols-[2.5rem_1fr_4.5rem_5.5rem_4rem]"
      >
        <span className="num text-xs text-muted">{set.year ?? "—"}</span>

        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm">{set.name}</span>
          {/* Kattis publishes only a handful of problems for some contests —
              say so rather than let a 1-problem "regional" look broken. */}
          {set.problem_count < 5 && (
            <span
              className="shrink-0 rounded-md bg-card-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted"
              title={`Kattis publishes only ${set.problem_count} problem${
                set.problem_count === 1 ? "" : "s"
              } from this contest`}
            >
              partial
            </span>
          )}
        </span>

        <span
          className="num hidden text-right text-xs text-muted sm:block"
          title="Kattis difficulty range"
        >
          {set.min_difficulty != null
            ? `${set.min_difficulty.toFixed(1)}–${set.max_difficulty?.toFixed(1)}`
            : ""}
        </span>

        <span className="flex items-center justify-end gap-2">
          <span
            className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-card-2 sm:block"
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
          <span
            className={`num text-xs ${
              set.solved_count > 0 ? "text-ink" : "text-muted"
            }`}
          >
            {set.solved_count}/{set.problem_count}
          </span>
        </span>

        <span className="num hidden text-right text-xs text-muted sm:block">
          {started ? daysAgo(set.last_session_at) : ""}
        </span>
      </Link>
    </li>
  );
}

/* The ladder itself — the point of the page for someone training toward NAC. */
function Ladder({
  ladder,
  activeLevel,
}: {
  ladder: { level: string; sets: number; solved: number; problems: number; sessions: number }[];
  activeLevel?: string;
}) {
  const rungs = LEVEL_ORDER.filter((l) => l !== "practice")
    .map((level) => ({
      level,
      meta: ICPC_LEVELS[level],
      data: ladder.find((r) => r.level === level),
    }))
    .filter((r) => r.data);

  if (rungs.length === 0) return null;

  return (
    <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {rungs.map((r) => {
        const active = activeLevel === r.level;
        const pct = r.data!.problems
          ? (r.data!.solved / r.data!.problems) * 100
          : 0;
        return (
          <Link
            key={r.level}
            href={active ? "/icpc" : `/icpc?level=${r.level}`}
            aria-current={active ? "true" : undefined}
            className="rounded-(--radius-card) border p-3.5 transition-colors"
            style={{
              borderColor: active ? "var(--icpc)" : "var(--line)",
              backgroundColor: active ? "var(--icpc-soft)" : "var(--card)",
            }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium">{r.meta.label}</span>
              {r.meta.you && (
                <span
                  className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                  style={{ backgroundColor: "var(--icpc)" }}
                >
                  your goal
                </span>
              )}
            </div>
            <div className="num mt-1.5 text-[19px] font-semibold leading-none">
              {r.data!.solved}
              <span className="text-xs font-normal text-muted">
                {" "}
                / {r.data!.problems} solved
              </span>
            </div>
            <span
              className="mt-2 block h-1 overflow-hidden rounded-full bg-card-2"
              aria-hidden
            >
              <span
                className="block h-full rounded-full"
                style={{ width: `${pct}%`, backgroundColor: "var(--icpc)" }}
              />
            </span>
            <div className="mt-1.5 text-[11px] text-muted">
              {r.data!.sets} sets
              {r.data!.sessions > 0 && ` · ${r.data!.sessions} run`}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
