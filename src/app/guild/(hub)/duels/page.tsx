import { redirect } from "next/navigation";
import DuelPanel from "@/components/DuelPanel";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/** One guildmate, one problem, first AC wins. */
export default async function GuildDuelsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  if (!(await getMyGuild(user.id))) redirect("/guild");

  return (
    <div>
      <div className="mb-3">
        <h2 className="font-display text-[22px] font-semibold tracking-tight">
          Duels
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Challenge one guildmate. They have five minutes to accept; then you
          both get the same unseen problem, drawn near your average rating, and
          the first accepted solution wins. Solving happens on Codeforces as
          usual — the winner is read off the judge&apos;s own clock. Nothing but
          pride at stake.
        </p>
      </div>
      <DuelPanel meId={user.id} />
    </div>
  );
}
