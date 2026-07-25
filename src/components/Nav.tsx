"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/solve", label: "Solve" },
  { href: "/icpc", label: "ICPC" },
  { href: "/mistakes", label: "Mistakes" },
];

export default function Nav({
  handle,
  rating,
  rank,
}: {
  handle: string | null;
  rating: number | null;
  rank: string | null;
}) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-page/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-md">
          <span
            aria-hidden
            className="num grid size-7 place-items-center rounded-[8px] bg-accent text-[11px] font-bold text-accent-ink"
          >
            {"//"}
          </span>
          <span className="font-display hidden text-[15px] font-semibold tracking-tight sm:block">
            CP Trainer
          </span>
        </Link>

        <nav className="ml-2 flex items-center gap-1 sm:ml-6" aria-label="Main">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-accent-soft font-medium text-accent-dk"
                    : "text-muted hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {handle && (
            <Link
              href="/settings"
              className="flex items-center gap-2 rounded-full border border-line bg-card p-1 text-sm hover:border-accent/50 sm:py-1 sm:pl-3 sm:pr-2"
              title={rank ?? undefined}
            >
              <span className="hidden max-w-28 truncate text-muted sm:block">
                {handle}
              </span>
              <span className="num rounded-full bg-card-2 px-2 py-0.5 text-xs font-medium">
                {rating ?? "—"}
              </span>
            </Link>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
