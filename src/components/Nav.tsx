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
  { href: "/contests", label: "Contests" },
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
      {/* On phones the row can't hold links *and* chips, and a row that
          overflows forces the whole page wider than the screen — so the links
          drop to their own edge-to-edge line and scroll sideways if squeezed. */}
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-2 px-4 sm:h-14 sm:flex-nowrap sm:gap-x-4 sm:px-6">
        <Link href="/" className="flex h-12 items-center gap-2.5 rounded-md sm:h-auto">
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

        <nav
          className="no-scrollbar order-last -mx-4 flex basis-full items-center gap-1 overflow-x-auto px-4 pb-2 sm:order-none sm:mx-0 sm:ml-6 sm:basis-auto sm:overflow-visible sm:p-0"
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
                className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors ${
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
