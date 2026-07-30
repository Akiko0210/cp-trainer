"use client";

import { useChampion } from "./GuildChampions";
import { Avatar, Crown, shortName } from "./guild-ui";

/*
  Who holds this area, on the category card itself.

  This is the whole point of the guild being singular: the answer to "who's
  strongest in Graphs" belongs next to Graphs, not on a separate page you have
  to remember to open. One line, and it changes hands live.
*/
export default function CrownBadge({
  categorySlug,
  meId,
}: {
  categorySlug: string;
  meId: number;
}) {
  const { champion, contenders, justTaken } = useChampion(categorySlug);
  if (!champion) return null;

  const isMe = champion.user_id === meId;
  return (
    <div
      className={`mt-2.5 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] ${
        justTaken ? "crown-taken" : ""
      }`}
      style={{
        backgroundColor: isMe ? "var(--accent-soft)" : "transparent",
        marginInline: "-0.375rem",
      }}
      title={
        contenders > 1
          ? `Strongest of ${contenders} guildmates with an estimate here`
          : "The only guildmate with an estimate here"
      }
    >
      <Crown size={12} className="shrink-0" style={{ color: "var(--streak-b)" }} />
      <Avatar user={champion} size={16} />
      <span className={`truncate ${isMe ? "font-semibold text-accent-dk" : ""}`}>
        {isMe ? "you hold this" : shortName(champion)}
      </span>
      {champion.estimate != null && (
        <span className="num ml-auto shrink-0 text-muted">
          {Math.round(champion.estimate)}
        </span>
      )}
    </div>
  );
}
