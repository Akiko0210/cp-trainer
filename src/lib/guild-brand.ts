/*
  A guild's visual identity, derived rather than stored.

  Every guild gets a monogram and a hue so it reads as *somewhere you belong*
  instead of a row in a table — but asking a club president to pick a colour is
  a settings screen nobody needs, and a free colour choice would sooner or later
  collide with the reserved verdict colours (green/red/amber mean AC/WA/TLE and
  nothing else). Deriving the hue from the slug keeps it stable, unique-ish, and
  inside a safe band.

  Pure functions, no imports: this runs in both server and client components.
*/

/** Up to two letters, from the initials of the name. */
export function guildMonogram(name: string): string {
  const words = name
    .split(/[\s\-_/]+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .slice(0, 3);
  if (words.length === 0) return "G";
  // "SJSU Competitive Programming" is called SJSU, not SC — when the first word
  // is already an acronym, the monogram comes from inside it.
  if (words[0].length >= 2 && words[0] === words[0].toUpperCase()) {
    return words[0].slice(0, 2).toUpperCase();
  }
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * A stable hue for a guild, restricted to the cool half of the wheel
 * (215°–330°: indigo through violet to magenta). That's the brand's own range,
 * and it keeps every guild clear of the verdict colours.
 */
export function guildHue(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) % 4096;
  }
  return 215 + (h % 116);
}

export function guildColors(slug: string): { base: string; deep: string } {
  const hue = guildHue(slug);
  return {
    base: `oklch(0.62 0.19 ${hue})`,
    // Second stop for gradients — a touch further round and lighter, so the
    // band has direction instead of being a flat wash.
    deep: `oklch(0.68 0.21 ${(hue + 38) % 360})`,
  };
}
