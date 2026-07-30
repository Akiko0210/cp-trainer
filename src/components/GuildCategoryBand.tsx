"use client";

import { useChampion } from "./GuildChampions";
import { Avatar, Crown, shortName } from "./guild-ui";

/*
  "Who's strongest in this area, in my guild" — answered on the area's own page,
  in the area's own colour.

  Reads from the shared champions store, so it's live and can't disagree with
  the crown on the dashboard card or the grid on the guild page. The gap to the
  holder is the number that makes this actionable: it turns a leaderboard into a
  target.
*/
export default function GuildCategoryBand({
  categorySlug,
  categoryName,
  meId,
}: {
  categorySlug: string;
  categoryName: string;
  meId: number;
}) {
  const { champion, runnerUp, you, contenders, justTaken } =
    useChampion(categorySlug);
  if (!champion) return null;

  const mine = champion.user_id === meId;
  const gap =
    !mine && you?.estimate != null && champion.estimate != null
      ? Math.round(champion.estimate - you.estimate)
      : null;

  return (
    <div
      className={`rounded-(--radius-card) border border-line p-4 ${
        justTaken ? "crown-taken" : ""
      }`}
      style={{
        backgroundImage:
          "linear-gradient(color-mix(in oklab, var(--cat) 8%, transparent), transparent 70%)",
      }}
    >
      <div className="mb-3 flex items-center gap-2">
        <Crown size={13} style={{ color: "var(--cat)" }} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
          {mine ? `You hold ${categoryName}` : `Guild ${categoryName} champion`}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <Avatar user={champion} size={38} ring="var(--cat)" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {mine ? "You" : (champion.display_name ?? champion.github_login)}
          </div>
          <div className="num text-[11px] text-muted">
            est {Math.round(champion.estimate ?? 0)}
            {contenders > 1 && (
              <span className="font-sans"> · of {contenders} rated here</span>
            )}
          </div>
        </div>
      </div>

      <dl className="mt-3 flex flex-col gap-1.5 border-t border-line pt-2.5 text-[12px]">
        {runnerUp && (
          <div className="flex items-center justify-between gap-2">
            <dt className="truncate text-muted">
              2nd · {runnerUp.user_id === meId ? "you" : shortName(runnerUp)}
            </dt>
            <dd className="num shrink-0">
              {Math.round(runnerUp.estimate ?? 0)}
            </dd>
          </div>
        )}
        {/* Not twice: the runner-up line above already names you if that's you. */}
        {!mine && (you == null || you.rank > 2) && (
          <div className="flex items-center justify-between gap-2">
            <dt className="truncate text-muted">
              {you ? (
                <>
                  You · #<span className="num">{you.rank}</span>
                </>
              ) : (
                "You · not rated here yet"
              )}
            </dt>
            <dd className="num shrink-0">
              {you?.estimate != null ? Math.round(you.estimate) : "—"}
            </dd>
          </div>
        )}
        {gap != null && gap > 0 && (
          <div className="text-[12px] text-muted">
            <span className="num font-semibold text-ink">{gap}</span> points from
            taking it.
          </div>
        )}
        {mine && (
          <div className="text-[12px] text-muted">
            Hold it by keeping the estimate up — it changes hands on ability, not
            on activity.
          </div>
        )}
      </dl>
    </div>
  );
}
