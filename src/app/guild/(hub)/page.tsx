import { redirect } from "next/navigation";
import GuildDoor from "../GuildDoor";
import LeaveGuild from "../LeaveGuild";
import ArenaStrip from "@/components/ArenaStrip";
import ChampionsGrid from "@/components/ChampionsGrid";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/** Overview: who holds what, plus anything live in the arena right now. */
export default async function GuildOverviewPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");

  const guild = await getMyGuild(user.id);
  // One guild per person, so there's no list to choose from: either you're in
  // one and this is it, or you're at the door. Rendered without the hub
  // chrome — the layout above bows out when there's no guild.
  if (!guild) return <GuildDoor />;

  return (
    <div>
      {/* Live arena state, one line unless something is actually happening. */}
      <ArenaStrip meId={user.id} />

      <div className="mb-3">
        <h2 className="font-display text-[22px] font-semibold tracking-tight">
          Who holds what
        </h2>
        <p className="mt-1 text-sm text-muted">
          Strongest guildmate in each area, by fitted estimate — so a title is
          lost to someone improving, not to the holder taking a week off.
        </p>
      </div>
      <ChampionsGrid meId={user.id} />

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
