import Link from "next/link";
import { redirect } from "next/navigation";
import BattleRoom from "@/components/BattleRoom";
import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/** One battle's room: lobby, live ladder, or the final record. */
export default async function BattleRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  if (!(await getMyGuild(user.id))) redirect("/guild");
  const { id } = await params;

  return (
    <div>
      <Link
        href="/guild/battles"
        className="mb-3 inline-block text-sm text-muted hover:text-ink"
      >
        ← Battle arena
      </Link>
      <BattleRoom id={Number(id)} meId={user.id} />
    </div>
  );
}
