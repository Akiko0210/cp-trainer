import Link from "next/link";
import { verdictMeta } from "@/lib/taxonomy";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-(--radius-card) border border-line bg-card p-5 ${className}`}
    >
      {children}
    </section>
  );
}

/* Section label: small caps, encodes structure (§7 — labels must mean something). */
export function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
      {children}
    </div>
  );
}

export function VerdictBadge({ verdict }: { verdict: string | null }) {
  const m = verdictMeta(verdict);
  return (
    <span
      title={m.label}
      className={`num inline-block rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${m.fg} ${m.bg}`}
    >
      {m.short}
    </span>
  );
}

export function TrendMark({ trend }: { trend: number | null | undefined }) {
  if (!trend) return null;
  return (
    <span
      className="num text-xs text-muted"
      title={trend > 0 ? "Rising over the last 30 days" : "Falling over the last 30 days"}
    >
      {trend > 0 ? "↗" : "↘"}
    </span>
  );
}

export function StatTile({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
        {label}
      </div>
      <div className="num mt-1.5 text-[26px] font-semibold leading-none">{value}</div>
      {sub && <div className="mt-1.5 text-xs text-muted">{sub}</div>}
    </>
  );
  const cls = "rounded-(--radius-card) border border-line bg-card p-4";
  return href ? (
    <Link href={href} className={`${cls} block transition-colors hover:border-accent/50`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/* Empty state: an invitation to act, in the app's voice (§7 quality floor). */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-(--radius-card) border border-dashed border-line px-6 py-10 text-center">
      <div className="font-display text-[15px] font-semibold">{title}</div>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
