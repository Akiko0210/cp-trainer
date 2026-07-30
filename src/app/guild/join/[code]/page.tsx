import Link from "next/link";
import { redirect } from "next/navigation";
import JoinButton from "./JoinButton";
import { Crest } from "@/components/guild-ui";
import { Card } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { getGuildByCode, getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/*
  The invite link. Shows what you're about to join before you join it — a bare
  code in a Discord message tells you nothing, and this is also the page that
  has to explain the one-guild rule to someone who's already in one.
*/
export default async function JoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const user = await getSessionUser();
  // Sign in first, then land back here rather than on the dashboard.
  if (!user) redirect(`/signin?next=${encodeURIComponent(`/guild/join/${code}`)}`);

  const guild = await getGuildByCode(code, user.id);
  const mine = await getMyGuild(user.id);
  if (guild && mine && guild.id === mine.id) redirect("/guild");

  return (
    <div className="mx-auto mt-20 max-w-md">
      <Card>
        {!guild ? (
          <>
            <h1 className="font-display text-xl font-semibold">
              That invite doesn&apos;t work
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              No guild has the code{" "}
              <span className="num tracking-widest">{code.toUpperCase()}</span>.
              It may have been rotated — ask whoever sent it for a fresh link.
            </p>
            <Link
              href="/guild"
              className="mt-4 inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90"
            >
              Back to guilds
            </Link>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Crest name={guild.name} slug={guild.slug} size={44} />
              <div className="min-w-0">
                <h1 className="font-display truncate text-xl font-semibold">
                  {guild.name}
                </h1>
                <p className="num text-xs text-muted">
                  {guild.member_count} member
                  {guild.member_count === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            {guild.tagline && (
              <p className="mt-3 text-sm text-muted">{guild.tagline}</p>
            )}

            {mine ? (
              <>
                <p className="mt-4 text-sm leading-relaxed text-muted">
                  You&apos;re in <span className="text-ink">{mine.name}</span>,
                  and a person belongs to one guild at a time. Leave that one
                  first if you mean to switch.
                </p>
                <Link
                  href="/guild"
                  className="mt-4 inline-block rounded-xl border border-line px-4 py-2.5 text-sm font-medium hover:bg-card-2"
                >
                  Go to {mine.name}
                </Link>
              </>
            ) : (
              <>
                <p className="mt-4 text-sm leading-relaxed text-muted">
                  Joining puts you on their boards — overall, per area, and
                  streaks — and puts them on yours.
                </p>
                <JoinButton code={code} />
              </>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
