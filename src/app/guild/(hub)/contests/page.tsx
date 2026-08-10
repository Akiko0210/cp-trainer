import { redirect } from "next/navigation";
import ContestPanel from "@/components/ContestPanel";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/** A custom set for the whole roster, on one clock. */
export default async function GuildContestsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  if (!(await getMyGuild(user.id))) redirect("/guild");

  return (
    <div>
      <div className="mb-3">
        <h2 className="font-display text-[22px] font-semibold tracking-tight">
          Guild contests
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Open a lobby, pick how many problems and which rating band, and anyone
          in the guild can join. Problems are drawn when the contest starts —
          against the field that actually turned up — so nobody has seen theirs.
          Most solves wins; ties go to the faster total, with no penalty for a
          wrong answer.
        </p>
      </div>
      <ContestPanel meId={user.id} />
    </div>
  );
}
