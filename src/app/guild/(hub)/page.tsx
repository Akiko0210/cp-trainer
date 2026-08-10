import { redirect } from "next/navigation";
import GuildDoor from "../GuildDoor";
import LeaveGuild from "../LeaveGuild";
import Leaderboard from "@/components/Leaderboard";
import { getSessionUser } from "@/lib/auth";
import { getGuildActivity, getMyGuild, getStandings } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/**
 * The guild's default view: where everyone stands, and what they've been
 * solving. This is the question people open a guild to answer, so it gets the
 * bare /guild URL rather than a tab they have to find.
 */
export default async function GuildStandingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");

  const guild = await getMyGuild(user.id);
  // One guild per person, so there's no list to choose from: either you're in
  // one and this is it, or you're at the door. Rendered without the hub
  // chrome — the layout above bows out when there's no guild.
  if (!guild) return <GuildDoor />;

  const [standings, activity] = await Promise.all([
    getStandings(guild.id, "elo"),
    getGuildActivity(guild.id, 12),
  ]);

  const solved30 = standings.reduce((n, s) => n + s.solved_30d, 0);
  const bestStreak = standings.reduce((n, s) => Math.max(n, s.streak), 0);

  return (
    <div>
      <div className="mb-3">
        <h2 className="font-display text-[22px] font-semibold tracking-tight">
          Standings
        </h2>
        <p className="mt-1 text-sm text-muted">
          Ability is the calibrated Rasch estimate, which prices what you fail as
          well as what you clear — grinding easy problems can&apos;t move it.
        </p>
        <p className="num mt-2 text-xs text-muted">
          {solved30} solved in 30d
          <span className="font-sans"> · best streak </span>
          {bestStreak}
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
