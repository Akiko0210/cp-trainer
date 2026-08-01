"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import GuildChip from "./GuildChip";
import StreakChip from "./StreakChip";
import ThemeToggle from "./ThemeToggle";
import type { MyStanding } from "@/lib/guild-queries";
import type { Streak } from "@/lib/queries";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/solve", label: "Solve" },
  { href: "/icpc", label: "ICPC" },
  { href: "/guild", label: "Guild" },
  { href: "/mistakes", label: "Mistakes" },
];

export default function Nav({
  handle,
  rating,
  rank,
  guild,
  standing,
  streak,
}: {
  handle: string | null;
  rating: number | null;
  rank: string | null;
  guild: { slug: string; name: string; member_count: number } | null;
  standing: MyStanding | null;
  streak: Streak | null;
}) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-page/85 backdrop-blur">
      {/*
        Two rows until lg, one above it. The link row is `w-full` so flex-wrap
        drops it onto its own line below the logo and chips; `lg:w-auto` with
        `lg:flex-nowrap` pulls it back inline. The `order` swap is what lets the
        chips sit top-right on the stacked layout while staying to the right of
        the links on the wide one — one copy of the list in the DOM either way.

        The switch is at lg, not sm: logo + wordmark + five links + the chip
        cluster need ~790px on one line, so turning it on at 640 put every page
        into horizontal scroll for the whole tablet range.
      */}
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-2 px-4 sm:px-6 lg:h-14 lg:flex-nowrap lg:gap-x-4">
        <Link href="/" className="order-1 flex h-14 items-center gap-2.5 rounded-md lg:h-auto">
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

        {/* Full-bleed and scrollable: five pills fit from 360px up, and on the
            narrowest phones a scrollable row beats a clipped fifth link. */}
        <nav
          className="no-scrollbar order-3 -mx-4 flex w-full items-center gap-0.5 overflow-x-auto px-4 pb-2 lg:order-2 lg:mx-0 lg:ml-6 lg:w-auto lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0"
          aria-label="Main"
        >
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-10 shrink-0 items-center rounded-full px-2 text-[13px] transition-colors lg:min-h-0 lg:px-3 lg:py-1.5 lg:text-sm ${
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

        <div className="order-2 ml-auto flex h-14 items-center gap-2 lg:order-3 lg:h-auto lg:gap-3">
          {/* Streak first: it's the one number here that can be lost today. */}
          {streak && <StreakChip initial={streak} />}
          {/* Your standing among your guild, on every page — same visual family
              as the rating chip beside it, because it is the same kind of fact. */}
          {guild && standing && <GuildChip guild={guild} standing={standing} />}
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
