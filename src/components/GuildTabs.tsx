"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/*
  The guild's own sub-navigation.

  One page carrying the crest, the champions, the full standings, a duel form,
  a contest lobby and a tournament ladder is a page you scroll past rather
  than read. These are five separate questions — where does everyone stand,
  who holds what, who am I racing, what's the club running, who's climbing the
  arena — so they get five pages under one roof.
  The header above stays put; only the panel below it changes.

  Standings takes the bare /guild URL because it is the question people open a
  guild to answer; the rest are somewhere you go on purpose.
*/
const TABS: readonly { href: string; label: string; prefix?: boolean }[] = [
  { href: "/guild", label: "Standings" },
  { href: "/guild/champions", label: "Champions" },
  { href: "/guild/duels", label: "Duels" },
  { href: "/guild/contests", label: "Contests" },
  // A battle has a room of its own (/guild/battles/[id]) — the one tab that
  // owns a subtree, so the one tab that matches by prefix.
  { href: "/guild/battles", label: "Battle arena", prefix: true },
];

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
        // Exact match only: /guild must not light up on /guild/duels. Only
        // the tab that owns nested pages matches by prefix.
        const active =
          pathname === tab.href ||
          (!!tab.prefix && pathname.startsWith(`${tab.href}/`));
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
