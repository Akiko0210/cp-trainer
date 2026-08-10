"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/*
  The guild's own sub-navigation.

  One page carrying the crest, the champions, the full standings, a duel form
  and a contest lobby is a page you scroll past rather than read. These are
  four separate questions — who holds what, where does everyone stand, who am
  I racing, what's the club running — so they get four pages under one roof.
  The header above stays put; only the panel below it changes.
*/
const TABS = [
  { href: "/guild", label: "Overview" },
  { href: "/guild/standings", label: "Standings" },
  { href: "/guild/duels", label: "Duels" },
  { href: "/guild/contests", label: "Contests" },
] as const;

export default function GuildTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Guild"
      // Scrolls sideways rather than wrapping on a phone, the same rule the
      // main nav follows — a tab row that wraps to two lines reads as two
      // different things.
      className="mb-6 -mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab) => {
        // Exact match only: /guild must not light up on /guild/duels.
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-ink text-page"
                : "text-muted hover:bg-card hover:text-ink"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
