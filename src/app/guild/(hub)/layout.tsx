import InviteCode from "../InviteCode";
import GuildTabs from "@/components/GuildTabs";
import { Crest } from "@/components/guild-ui";
import { getSessionUser } from "@/lib/auth";
import { guildColors } from "@/lib/guild-brand";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/*
  The chrome every guild page shares: the crest, the name, the invite code, and
  the tab row. A route group (not a path segment) so these wrap /guild,
  /guild/standings, /guild/duels and /guild/contests without appearing in any
  URL — and so /guild/join/[code], which is shown to people who are not in a
  guild yet, stays outside it and keeps its own bare layout.

  The hero carries only what `getMyGuild` already returned. Activity numbers
  (30-day solves, best streak) used to live here too, but they come out of the
  standings query — running that on the duels tab to fill in two words of
  header is the kind of cost that hides in a layout and never gets found. They
  now sit on the Standings page, where the query runs anyway.
*/
export default async function GuildHubLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();
  // Not signed in, or not in a guild: no chrome to draw. The pages below
  // handle both cases themselves (sign-in redirect, or the join/create door),
  // and a header for a guild you aren't in would be a lie.
  if (!user) return <>{children}</>;
  const guild = await getMyGuild(user.id);
  if (!guild) return <>{children}</>;

  const { base, deep } = guildColors(guild.slug);
  const canInvite = guild.my_role === "leader" || guild.my_role === "officer";

  return (
    <div className="pt-6">
      {/* ---- hero: the guild's own colours, derived from its slug ---- */}
      <div
        // relative + z-10 + an opaque base so leaderboard rows in flight slide
        // *behind* the header rather than across it.
        className="relative z-10 mb-4 overflow-hidden rounded-(--radius-card) border border-line bg-page p-5"
        style={{
          backgroundImage: `linear-gradient(105deg, color-mix(in oklab, ${base} 14%, transparent), color-mix(in oklab, ${deep} 7%, transparent))`,
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Crest name={guild.name} slug={guild.slug} size={46} />
            <div className="min-w-0">
              <h1 className="font-display text-[26px] font-semibold leading-tight tracking-tight">
                {guild.name}
              </h1>
              {guild.tagline && (
                <p className="mt-0.5 text-sm text-muted">{guild.tagline}</p>
              )}
              <p className="num mt-1.5 text-xs text-muted">
                {guild.member_count} member{guild.member_count === 1 ? "" : "s"}
                {guild.linked_count < guild.member_count && (
                  <span className="font-sans">
                    {" · "}
                    {guild.member_count - guild.linked_count} still to link a
                    handle
                  </span>
                )}
              </p>
            </div>
          </div>
          {canInvite && <InviteCode code={guild.invite_code} />}
        </div>
      </div>

      <GuildTabs />

      {children}
    </div>
  );
}
