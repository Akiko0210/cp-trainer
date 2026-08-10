import { redirect } from "next/navigation";
import ChampionsGrid from "@/components/ChampionsGrid";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/** Who is strongest in each area — the guild's eight standing titles. */
export default async function GuildChampionsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  if (!(await getMyGuild(user.id))) redirect("/guild");

  return (
    <div>
      <div className="mb-3">
        <h2 className="font-display text-[22px] font-semibold tracking-tight">
          Who holds what
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Strongest guildmate in each area, by fitted estimate — so a title is
          lost to someone improving, not to the holder taking a week off.
        </p>
      </div>
      <ChampionsGrid meId={user.id} />
    </div>
  );
}
