import { redirect } from "next/navigation";
import GuildDoor from "./GuildDoor";
import InviteCode from "./InviteCode";
import LeaveGuild from "./LeaveGuild";
import ChampionsGrid from "@/components/ChampionsGrid";
import ContestPanel from "@/components/ContestPanel";
import DuelPanel from "@/components/DuelPanel";
import Leaderboard from "@/components/Leaderboard";
import { Crest } from "@/components/guild-ui";
import { getSessionUser } from "@/lib/auth";
import { guildColors } from "@/lib/guild-brand";
import { getGuildActivity, getMyGuild, getStandings } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

export default async function GuildPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");

  const guild = await getMyGuild(user.id);
  // One guild per person, so there's no list to choose from: either you're in
  // one and this is it, or you're at the door.
  if (!guild) return <GuildDoor />;

  const [standings, activity] = await Promise.all([
    getStandings(guild.id, "elo"),
    getGuildActivity(guild.id, 12),
  ]);

  const { base, deep } = guildColors(guild.slug);
  const solved30 = standings.reduce((n, s) => n + s.solved_30d, 0);
  const bestStreak = standings.reduce((n, s) => Math.max(n, s.streak), 0);
  const canInvite = guild.my_role === "leader" || guild.my_role === "officer";

  return (
    <div className="pt-6">
      {/* ---- hero: the guild's own colours, derived from its slug ---- */}
      <div
        // relative + z-10 + an opaque base so leaderboard rows in flight slide
        // *behind* the header rather than across it.
        className="relative z-10 mb-5 overflow-hidden rounded-(--radius-card) border border-line bg-page p-6"
        style={{
          backgroundImage: `linear-gradient(105deg, color-mix(in oklab, ${base} 14%, transparent), color-mix(in oklab, ${deep} 7%, transparent))`,
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Crest name={guild.name} slug={guild.slug} size={54} />
            <div className="min-w-0">
              <h1 className="font-display text-[28px] font-semibold leading-tight tracking-tight">
                {guild.name}
              </h1>
              {guild.tagline && (
                <p className="mt-0.5 text-sm text-muted">{guild.tagline}</p>
              )}
              <p className="num mt-2 text-xs text-muted">
                {guild.member_count} member{guild.member_count === 1 ? "" : "s"}
                <span className="font-sans"> · </span>
                {solved30} solved in 30d
                <span className="font-sans"> · best streak </span>
                {bestStreak}
                {guild.linked_count < guild.member_count && (
                  <span className="font-sans">
                    {" · "}
                    {guild.member_count - guild.linked_count} still to link a
                    handle
                  </span>
                )}
              </p>
            </div>
          </div>
          {canInvite && <InviteCode code={guild.invite_code} />}
        </div>
      </div>

      {/* ---- champions ---- */}
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-[22px] font-semibold tracking-tight">
            Who holds what
          </h2>
          <p className="mt-1 text-sm text-muted">
            Strongest guildmate in each area, by fitted estimate — so a title is
            lost to someone improving, not to the holder taking a week off.
          </p>
        </div>
      </div>
      <div className="mb-8">
        <ChampionsGrid meId={user.id} />
      </div>

      {/* ---- the arena: duels + custom contests ---- */}
      <div className="mb-3">
        <h2 className="font-display text-[22px] font-semibold tracking-tight">
          Arena
        </h2>
        <p className="mt-1 text-sm text-muted">
          Races, not ratings: challenge a guildmate to a duel, or throw a
          custom contest of random unseen problems. Nothing here touches
          anyone&apos;s scores.
        </p>
      </div>
      <div className="mb-8 grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <DuelPanel meId={user.id} />
        <ContestPanel meId={user.id} />
      </div>

      {/* ---- full standings ---- */}
      <div className="mb-3">
        <h2 className="font-display text-[22px] font-semibold tracking-tight">
          Standings
        </h2>
        <p className="mt-1 text-sm text-muted">
          Ability is the calibrated Rasch estimate, which prices what you fail as
          well as what you clear — grinding easy problems can&apos;t move it.
        </p>
      </div>
      <Leaderboard meId={user.id} initial={{ standings, activity }} />

      <div className="mt-10 border-t border-line pt-4">
        <LeaveGuild
          name={guild.name}
          isLeader={guild.my_role === "leader"}
          lastMember={guild.member_count === 1}
        />
      </div>
    </div>
  );
}
