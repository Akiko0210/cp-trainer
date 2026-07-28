"use client";

import { useRouter } from "next/navigation";
import Select from "@/components/Select";
import type { SetFilterOptions } from "@/lib/icpc-queries";
import { ICPC_LEVELS } from "@/lib/taxonomy";

/*
  One filter row above the list. Region and series are dependent: picking
  "Europe" narrows the series list to Europe's, because offering "Pacific
  Northwest" under Europe would just be an empty result waiting to happen.
*/
export default function IcpcFilters({
  options,
  current,
}: {
  options: SetFilterOptions;
  current: { level?: string; region?: string; series?: string; year?: number };
}) {
  const router = useRouter();

  function go(patch: Record<string, string | undefined>) {
    const next = { ...current, ...patch } as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v !== undefined && v !== "" && v !== null) params.set(k, String(v));
    }
    // Changing the region invalidates a series that lives elsewhere.
    if (patch.region !== undefined) params.delete("series");
    router.push(`/icpc${params.toString() ? `?${params}` : ""}`);
  }

  const seriesForRegion = options.series.filter(
    (s) =>
      (!current.region || s.region === current.region) &&
      (!current.level || s.level === current.level),
  );

  const active =
    current.level || current.region || current.series || current.year;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Select
        ariaLabel="Filter by region"
        className="w-44"
        accent="var(--icpc)"
        value={current.region ?? ""}
        onChange={(v) => go({ region: v || undefined })}
        options={[
          { value: "", label: "All regions" },
          ...options.regions.map((r) => ({
            value: r.region,
            label: r.region,
            hint: String(r.n),
          })),
        ]}
      />
      <Select
        ariaLabel="Filter by contest series"
        className="w-60"
        accent="var(--icpc)"
        value={current.series ?? ""}
        onChange={(v) => go({ series: v || undefined })}
        options={[
          { value: "", label: "All series" },
          ...seriesForRegion.map((s) => ({
            value: s.series,
            label: s.series,
            hint: String(s.n),
          })),
        ]}
      />
      <Select
        ariaLabel="Filter by year"
        className="w-32"
        accent="var(--icpc)"
        value={current.year ? String(current.year) : ""}
        onChange={(v) => go({ year: v || undefined })}
        options={[
          { value: "", label: "Any year" },
          ...options.years.map((y) => ({ value: String(y), label: String(y) })),
        ]}
      />
      {active && (
        <button
          onClick={() => router.push("/icpc")}
          className="rounded-(--radius-chip) px-3 py-2 text-sm text-muted hover:text-ink"
        >
          Clear
          {current.level && ` · ${ICPC_LEVELS[current.level]?.label ?? current.level}`}
        </button>
      )}
    </div>
  );
}
