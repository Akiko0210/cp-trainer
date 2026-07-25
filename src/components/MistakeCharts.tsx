"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MISTAKE_LABELS } from "@/lib/taxonomy";

/*
  Chart colors follow the dataviz rules:
  - mistake tags are IDENTITY -> validated categorical set (--chart-1..5),
    assigned in fixed order by tag, never cycled or reordered;
  - verdict mix is STATE -> the reserved verdict tokens, semantically honest.
*/

const tooltipStyle = {
  backgroundColor: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  fontSize: 12,
  color: "var(--ink)",
} as const;

export function TagTrendChart({
  data,
  tags,
}: {
  // one row per week: { week: "2026-06-01", off_by_one: 2, ... }
  data: Record<string, string | number>[];
  tags: string[]; // fixed order = fixed color slots
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -22 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="week"
          tick={{ fill: "var(--muted)", fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: "var(--line)" }}
          tickFormatter={(w: string) => w.slice(5)}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: "var(--muted)", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v, name) => [v, MISTAKE_LABELS[String(name)] ?? name]}
        />
        {tags.map((tag, i) => (
          <Line
            key={tag}
            type="monotone"
            dataKey={tag}
            stroke={`var(--chart-${i + 1})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function TagLegend({ tags }: { tags: string[] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {tags.map((tag, i) => (
        <span key={tag} className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-4 rounded-full"
            style={{ backgroundColor: `var(--chart-${i + 1})` }}
          />
          {MISTAKE_LABELS[tag] ?? tag}
        </span>
      ))}
    </div>
  );
}

export function VerdictMixChart({
  data,
}: {
  data: { month: string; ok: number; wa: number; tle: number; other: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -22 }}>
        <CartesianGrid stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="month"
          tick={{ fill: "var(--muted)", fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: "var(--line)" }}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: "var(--muted)", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "var(--card-2)" }}
          formatter={(v, name) =>
            [v, { ok: "AC", wa: "WA", tle: "TLE/MLE", other: "RE/CE/other" }[
              String(name)
            ] ?? name] as [React.ReactNode, string]
          }
        />
        {/* stacked, 2px gap via stroke on card color */}
        {(["ok", "wa", "tle", "other"] as const).map((k) => (
          <Bar
            key={k}
            dataKey={k}
            stackId="v"
            fill={`var(--${k === "other" ? "rece" : k === "ok" ? "ac" : k})`}
            stroke="var(--card)"
            strokeWidth={1}
            maxBarSize={36}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
