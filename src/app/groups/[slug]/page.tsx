import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import InviteCode from "./InviteCode";
import Leaderboard from "@/components/Leaderboard";
import { Card } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import {
  getGroup,
  getGroupActivity,
  getStandings,
} from "@/lib/group-queries";

export const dynamic = "force-dynamic";

export default async function GroupPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/signin");

  const group = await getGroup(slug, user.id);
  if (!group) notFound();

  // Non-members see the door, not the board.
  if (!group.role) {
    return (
      <div className="mx-auto mt-20 max-w-md">
        <Card>
          <h1 className="font-display text-xl font-semibold">{group.name}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            You&apos;re not in this group yet. Ask a member for the invite code,
            then enter it on the groups page.
          </p>
          <Link
            href="/groups"
            className="mt-4 inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            Enter a code
          </Link>
        </Card>
      </div>
    );
  }

  const [standings, activity] = await Promise.all([
    getStandings(group.id, "elo"),
    getGroupActivity(group.id, 12),
  ]);

  const linked = standings.filter((s) => s.linked).length;

  return (
    <div className="pt-6">
      <nav className="mb-4 text-sm text-muted" aria-label="Breadcrumb">
        <Link href="/groups" className="hover:text-ink">
          Groups
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink">{group.name}</span>
      </nav>

      <div
        // relative + z-10 + an opaque base so leaderboard rows in flight slide
        // *behind* the header rather than across it.
        className="relative z-10 mb-4 rounded-(--radius-card) border border-line bg-page p-6"
        style={{
          backgroundImage:
            "linear-gradient(105deg, color-mix(in oklab, var(--streak-a) 12%, transparent), color-mix(in oklab, var(--streak-b) 6%, transparent))",
        }}
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-[28px] font-semibold tracking-tight">
              {group.name}
            </h1>
            {group.description && (
              <p className="mt-1 text-sm text-muted">{group.description}</p>
            )}
            <p className="num mt-2 text-xs text-muted">
              {group.member_count} member{group.member_count === 1 ? "" : "s"}
              {linked < group.member_count && (
                <span className="font-sans">
                  {" "}
                  · {group.member_count - linked} still to link a handle
                </span>
              )}
            </p>
          </div>
          {(group.role === "owner" || group.role === "admin") && (
            <InviteCode slug={group.slug} code={group.invite_code} />
          )}
        </div>
      </div>

      <Leaderboard
        slug={group.slug}
        meId={user.id}
        initial={{ standings, activity }}
      />
    </div>
  );
}
