// Mistake taxonomy (handoff §6.2) — fixed so results aggregate.
// THE single place this list lives; the worker never needs it.
export const MISTAKE_TAGS = [
  { tag: "off_by_one", label: "Off-by-one", hint: "boundary / off-by-one" },
  { tag: "overflow", label: "Overflow", hint: "integer overflow" },
  { tag: "complexity", label: "Complexity", hint: "wrong complexity (TLE)" },
  { tag: "edge_case", label: "Edge case", hint: "n=0/1, empty, duplicates" },
  { tag: "misread", label: "Misread", hint: "misread the statement" },
  { tag: "wrong_algorithm", label: "Wrong algorithm", hint: "wrong approach" },
  { tag: "wrong_ds", label: "Wrong DS", hint: "wrong data structure" },
  { tag: "precision", label: "Precision", hint: "floating point / precision" },
  { tag: "state_reset", label: "State reset", hint: "state not reset between tests" },
  { tag: "io_format", label: "I/O format", hint: "input/output format" },
] as const;

export type MistakeTag = (typeof MISTAKE_TAGS)[number]["tag"];

export const MISTAKE_LABELS: Record<string, string> = Object.fromEntries(
  MISTAKE_TAGS.map((t) => [t.tag, t.label]),
);

// Verdict display meta. Color classes are the reserved verdict tokens —
// nothing else in the app may use green/red/amber.
export const VERDICTS: Record<
  string,
  { short: string; label: string; fg: string; bg: string }
> = {
  OK: { short: "AC", label: "Accepted", fg: "text-ac", bg: "bg-ac-soft" },
  WRONG_ANSWER: { short: "WA", label: "Wrong answer", fg: "text-wa", bg: "bg-wa-soft" },
  TIME_LIMIT_EXCEEDED: { short: "TLE", label: "Time limit", fg: "text-tle", bg: "bg-tle-soft" },
  MEMORY_LIMIT_EXCEEDED: { short: "MLE", label: "Memory limit", fg: "text-tle", bg: "bg-tle-soft" },
  IDLENESS_LIMIT_EXCEEDED: { short: "ILE", label: "Idleness limit", fg: "text-tle", bg: "bg-tle-soft" },
  RUNTIME_ERROR: { short: "RE", label: "Runtime error", fg: "text-rece", bg: "bg-rece-soft" },
  COMPILATION_ERROR: { short: "CE", label: "Compile error", fg: "text-rece", bg: "bg-rece-soft" },
  CHALLENGED: { short: "HACK", label: "Hacked", fg: "text-wa", bg: "bg-wa-soft" },
  PARTIAL: { short: "PT", label: "Partial", fg: "text-tle", bg: "bg-tle-soft" },
  SKIPPED: { short: "SK", label: "Skipped", fg: "text-pending", bg: "bg-card-2" },
  TESTING: { short: "…", label: "Testing", fg: "text-pending", bg: "bg-card-2" },
};

export function verdictMeta(verdict: string | null) {
  return (
    VERDICTS[verdict ?? ""] ?? {
      short: verdict?.slice(0, 3) ?? "—",
      label: verdict ?? "Unknown",
      fg: "text-pending",
      bg: "bg-card-2",
    }
  );
}

// ---------- categories (major ICPC areas; see worker/categories.py) ----------

export const CATEGORIES = [
  { slug: "fundamentals", name: "Fundamentals", blurb: "search, sorting, greedy, ad hoc" },
  { slug: "data-structures", name: "Data Structures", blurb: "sets to segment trees" },
  { slug: "graphs", name: "Graphs", blurb: "traversal, paths, trees" },
  { slug: "dp", name: "Dynamic Programming", blurb: "from knapsack to slope trick" },
  { slug: "math", name: "Math", blurb: "number theory, combinatorics, FFT" },
  { slug: "strings", name: "Strings", blurb: "hashing to suffix structures" },
  { slug: "geometry", name: "Geometry", blurb: "primitives, hulls, sweeps" },
  { slug: "flow", name: "Flows & Matchings", blurb: "max-flow, min-cost, matroids" },
] as const;

export const CATEGORY_NAMES: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.slug, c.name]),
);

// A category's theme color (CSS var set per theme in globals.css).
export function categoryColor(slug: string): string {
  return `var(--cat-${slug.replace(/^cat-/, "")})`;
}

// usaco.guide division -> tier inside a category (Suffix Array = Expert Strings).
export const TIERS: Record<string, { label: string; order: number }> = {
  Bronze: { label: "Basics", order: 0 },
  Silver: { label: "Core", order: 1 },
  Gold: { label: "Intermediate", order: 2 },
  Platinum: { label: "Advanced", order: 3 },
  Advanced: { label: "Expert", order: 4 },
};

// Score is current heat (level × evidence × freshness) — label it that way.
export function heatLabel(score: number | null): string {
  if (score == null) return "untouched";
  if (score >= 70) return "on fire";
  if (score >= 40) return "warm";
  if (score >= 15) return "cooling";
  return "cold";
}

// NOTE: there is deliberately no scoreBreakdown() here any more. Re-deriving
// the worker's formula in the client meant the displayed breakdown could drift
// from the stored score (it did). The worker now writes the factors it
// actually used into topic_mastery.factors — read those.

// Mastery score (0–100) -> ramp step 0..5 (0 = no data). CSS vars --m0..--m5
// carry the brand ramp; --mN-ink the readable text color on each step.
export function masteryStep(score: number | null | undefined): number {
  if (score == null) return 0;
  if (score < 20) return 1;
  if (score < 40) return 2;
  if (score < 60) return 3;
  if (score < 80) return 4;
  return 5;
}

export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function daysAgo(date: string | Date | null): string {
  if (!date) return "never";
  const d = typeof date === "string" ? new Date(date) : date;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}
