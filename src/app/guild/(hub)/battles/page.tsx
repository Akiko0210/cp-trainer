import { redirect } from "next/navigation";
import BattlesPanel from "@/components/BattlesPanel";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/** A scheduled tournament: tiers, 30-minute matches, last one standing. */
export default async function GuildBattlesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  if (!(await getMyGuild(user.id))) redirect("/guild");

  return (
    <div>
      <div className="mb-3">
        <h2 className="font-display text-[22px] font-semibold tracking-tight">
          Battle arena
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Anyone schedules one; the host plays like everyone else. Everyone starts
          at tier 1 and is paired with someone in their own tier, in queue order,
          for one problem at that tier&apos;s rating on a 30-minute clock. First
          accepted solution climbs a tier, the other side stays, a tie keeps
          both. Nobody drops — but alone at the bottom tier you&apos;re out, and
          the last one standing wins. Every match, opponent and problem is on
          the record afterwards.
        </p>
      </div>
      <BattlesPanel meId={user.id} />
    </div>
  );
}
