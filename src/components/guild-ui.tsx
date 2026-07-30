import { guildColors, guildMonogram } from "@/lib/guild-brand";

/* Small pieces shared by every guild surface: the crest, member avatars, and
   the crown that marks whoever holds an area. Presentational only, so they work
   in both server and client components. */

export function Crest({
  name,
  slug,
  size = 40,
}: {
  name: string;
  slug: string;
  size?: number;
}) {
  const { base, deep } = guildColors(slug);
  return (
    <span
      aria-hidden
      className="font-display grid shrink-0 place-items-center rounded-[10px] font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        backgroundImage: `linear-gradient(135deg, ${base}, ${deep})`,
      }}
    >
      {guildMonogram(name)}
    </span>
  );
}

export function Crown({
  size = 12,
  className = "",
  style,
}: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 18"
      width={size}
      height={size * 0.75}
      className={className}
      style={style}
      fill="currentColor"
    >
      <path d="M1 4.2c0-.9 1-1.4 1.7-.9L7 6.4l3.6-5c.7-.9 2.1-.9 2.8 0l3.6 5 4.3-3.1c.7-.5 1.7 0 1.7.9v9.9c0 1-.8 1.8-1.8 1.8H2.8C1.8 15.9 1 15.1 1 14.1V4.2Z" />
    </svg>
  );
}

export function Avatar({
  user,
  size,
  ring,
}: {
  user: { avatar_url?: string | null; display_name?: string | null };
  size: number;
  /** Colour of a 2px ring — used to mark the crown holder. */
  ring?: string;
}) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    ...(ring ? { boxShadow: `0 0 0 2px ${ring}` } : {}),
  };
  if (user.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.avatar_url}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full"
        style={style}
      />
    );
  }
  const initial = (user.display_name ?? "?").trim().charAt(0).toUpperCase();
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-card-2 font-semibold text-muted"
      style={{ ...style, fontSize: Math.max(9, size * 0.38) }}
    >
      {initial}
    </span>
  );
}

/** First name only — rosters get long and a card has one line to spend. */
export function shortName(
  member: { display_name?: string | null; github_login?: string | null } | null,
): string {
  if (!member) return "—";
  const name = member.display_name ?? member.github_login ?? "Member";
  return name.split(/\s+/)[0];
}
