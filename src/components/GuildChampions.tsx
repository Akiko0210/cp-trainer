"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useGuildLive } from "./GuildLive";
import type { CategoryChampions, Champion } from "@/lib/guild-queries";

/*
  The champions store.

  "Who is strongest in Graphs in my guild" is asked in several places at once —
  the eight dashboard cards, the band on a category page, the grid on the guild
  page. Each of those fetching for itself would mean eight-plus requests per
  live event, so they all read from this one store, which fetches once per event
  and is seeded server-side so the first paint is already correct.

  It also remembers who held each crown a moment ago, which is what lets a
  badge announce a takeover instead of quietly showing a different name.
*/

type ChampionsState = {
  byCategory: Map<string, CategoryChampions>;
  /** Categories whose holder changed on the last update. */
  justTaken: Set<string>;
};

const Ctx = createContext<ChampionsState>({
  byCategory: new Map(),
  justTaken: new Set(),
});

function toMap(list: CategoryChampions[]): Map<string, CategoryChampions> {
  return new Map(list.map((c) => [c.category_slug, c]));
}

export function useChampions(): ChampionsState {
  return useContext(Ctx);
}

/** The holder of one area, the runner-up, and where the viewer sits in it. */
export function useChampion(categorySlug: string): {
  champion: Champion | null;
  runnerUp: Champion | null;
  you: Champion | null;
  contenders: number;
  justTaken: boolean;
} {
  const { byCategory, justTaken } = useChampions();
  const slug = categorySlug.replace(/^cat-/, "");
  const entry = byCategory.get(slug);
  const members = entry?.members ?? [];
  return {
    champion: members[0] ?? null,
    runnerUp: members[1] ?? null,
    you: entry?.you ?? null,
    contenders: members[0]?.contenders ?? 0,
    justTaken: justTaken.has(slug),
  };
}

export default function GuildChampions({
  initial,
  children,
}: {
  initial: CategoryChampions[];
  children: React.ReactNode;
}) {
  const { version } = useGuildLive();
  const [byCategory, setByCategory] = useState(() => toMap(initial));
  const [justTaken, setJustTaken] = useState<Set<string>>(new Set());
  const holders = useRef<Map<string, number>>(
    new Map(initial.map((c) => [c.category_slug, c.members[0]?.user_id ?? 0])),
  );

  useEffect(() => {
    // version 0 is the server-rendered state we were seeded with.
    if (version === 0) return;
    let cancelled = false;

    void (async () => {
      const res = await fetch("/api/guild/champions");
      if (!res.ok || cancelled) return;
      const { champions } = (await res.json()) as {
        champions: CategoryChampions[];
      };
      if (cancelled) return;

      const taken = new Set<string>();
      for (const c of champions) {
        const now = c.members[0]?.user_id ?? 0;
        const before = holders.current.get(c.category_slug);
        // `before === undefined` is a category we simply hadn't seen yet, not a
        // takeover — a first-ever champion shouldn't flash as a steal.
        if (before !== undefined && before !== 0 && before !== now) {
          taken.add(c.category_slug);
        }
        holders.current.set(c.category_slug, now);
      }
      setByCategory(toMap(champions));
      setJustTaken(taken);
    })();

    return () => {
      cancelled = true;
    };
  }, [version]);

  // Let the takeover highlight fade on its own, so a crown that changed hands
  // reads as news for a few seconds and then becomes ordinary.
  useEffect(() => {
    if (justTaken.size === 0) return;
    const timer = setTimeout(() => setJustTaken(new Set()), 6000);
    return () => clearTimeout(timer);
  }, [justTaken]);

  return (
    <Ctx.Provider value={{ byCategory, justTaken }}>{children}</Ctx.Provider>
  );
}
