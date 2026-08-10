import { redirect } from "next/navigation";
import Leaderboard from "@/components/Leaderboard";
import { getSessionUser } from "@/lib/auth";
import { getGuildActivity, getMyGuild, getStandings } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/** The full board, and the club's recent activity underneath it. */
export default async function GuildStandingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");

  const guild = await getMyGuild(user.id);
  if (!guild) redirect("/guild");

  const [standings, activity] = await Promise.all([
    getStandings(guild.id, "elo"),
    getGuildActivity(guild.id, 12),
  ]);

  // Free here — the rows are already in hand. This is why the hero above
  // doesn't try to show them on every tab.
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
    </div>
  );
}
