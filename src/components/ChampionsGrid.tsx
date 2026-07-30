"use client";

import Link from "next/link";
import { useChampions } from "./GuildChampions";
import { Avatar, Crown, shortName } from "./guild-ui";
import { CATEGORIES, categoryColor } from "@/lib/taxonomy";

/*
  The champions board: eight areas, eight holders.

  Ranked on the per-area Rasch estimate, not the 0–100 heat score. Heat decays
  when you stop practising, and "strongest in Graphs" shouldn't change hands
  because the holder took a fortnight off — a title should be lost to someone
  getting better, not to a calendar.

  Every card is live. When a crown changes hands the card announces it for a few
  seconds (see .crown-taken) rather than quietly showing a different name.
*/
export default function ChampionsGrid({ meId }: { meId: number }) {
  const { byCategory, justTaken } = useChampions();

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {CATEGORIES.map((cat) => {
        const entry = byCategory.get(cat.slug);
        const champion = entry?.members[0] ?? null;
        const runnerUp = entry?.members[1] ?? null;
        // The viewer's own row comes from the query even when they're nowhere
        // near the podium — that's the number they actually want.
        const you = entry?.you ?? null;
        const mine = champion?.user_id === meId;
        const color = categoryColor(cat.slug);

        return (
          <Link
            key={cat.slug}
            href={`/categories/${cat.slug}`}
            style={
              {
                "--cat": color,
                backgroundImage:
                  "linear-gradient(color-mix(in oklab, var(--cat) 8%, transparent), transparent 60%)",
              } as React.CSSProperties
            }
            className={`group relative overflow-hidden rounded-(--radius-card) border border-line bg-card p-4 transition-colors hover:border-(--cat)/60 ${
              justTaken.has(cat.slug) ? "crown-taken" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 rounded-[4px]"
                style={{ backgroundColor: color }}
              />
              <span className="truncate text-[13px] font-semibold">
                {cat.name}
              </span>
              {mine && (
                <Crown
                  size={14}
                  className="ml-auto shrink-0"
                  style={{ color }}
                />
              )}
            </div>

            {champion ? (
              <>
                <div className="mt-3 flex items-center gap-2">
                  <Avatar user={champion} size={34} ring={color} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {mine ? "You" : shortName(champion)}
                    </div>
                    <div className="num text-[11px] text-muted">
                      est {Math.round(champion.estimate ?? 0)}
                      {champion.contenders > 1 && (
                        <span className="font-sans">
                          {" "}
                          · of {champion.contenders}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-3 border-t border-line pt-2 text-[11px] text-muted">
                  {runnerUp ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        2nd{" "}
                        {runnerUp.user_id === meId ? "you" : shortName(runnerUp)}
                      </span>
                      <span className="num shrink-0">
                        {Math.round(runnerUp.estimate ?? 0)}
                      </span>
                    </div>
                  ) : (
                    <div>no one else rated here yet</div>
                  )}

                  {/* Where you stand — but not twice: if you're the champion or
                      the runner-up you're already named above. */}
                  {!mine && (you == null || you.rank > 2) && (
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="truncate">
                        {you ? (
                          <>
                            you #<span className="num">{you.rank}</span>
                            {champion.estimate != null && you.estimate != null && (
                              <span className="num">
                                {" "}
                                · {Math.round(champion.estimate - you.estimate)}{" "}
                                behind
                              </span>
                            )}
                          </>
                        ) : (
                          "you: no estimate here yet"
                        )}
                      </span>
                      {you?.estimate != null && (
                        <span className="num shrink-0">
                          {Math.round(you.estimate)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="mt-3 text-[13px] text-muted">
                Nobody in the guild has a rated estimate here yet — the crown is
                unclaimed.
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
