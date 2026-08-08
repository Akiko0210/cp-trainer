import Link from "next/link";
import { redirect } from "next/navigation";
import ContestPanel from "@/components/ContestPanel";
import DuelPanel from "@/components/DuelPanel";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/*
  The arena, on its own page. It lived on /guild first, and the panels buried
  the leaderboard — a duel form you aren't using is furniture, and furniture
  doesn't get to sit between the hero and the standings. The guild page keeps
  a slim live strip (ArenaStrip) for anything time-sensitive; the full
  challenge/lobby machinery lives here, with room to breathe.
*/
export default async function ArenaPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  const guild = await getMyGuild(user.id);
  if (!guild) redirect("/guild");

  return (
    <div className="pt-6">
      <div className="mb-5">
        <Link
          href="/guild"
          className="text-sm text-muted transition-colors hover:text-ink"
        >
          ← {guild.name}
        </Link>
        <h1 className="font-display mt-1 text-[28px] font-semibold leading-tight tracking-tight">
          Arena
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Races, not ratings: challenge a guildmate to a duel, or throw a
          custom contest of random unseen problems. Solving happens on
          Codeforces as usual; winners are read off the judge&apos;s own clock.
          Nothing here touches anyone&apos;s scores.
        </p>
      </div>

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <DuelPanel meId={user.id} />
        <ContestPanel meId={user.id} />
      </div>
    </div>
  );
}
