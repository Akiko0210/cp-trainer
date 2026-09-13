/*
  The arena's rules as numbers — the bits both the server (validation, SQL)
  and the browser (forms, labels) need to agree on.

  No imports, on purpose: arena-queries.ts and battle-queries.ts pull in the
  database driver, and a client component that imported a constant from them
  would drag `pg` into the browser bundle. Types are erased; values are not.
*/

export type DuelMode = "classic" | "bullet";

/*
  Bullet: a clock and a ladder. The challenger picks the clock, where the
  ladder starts and how steeply it climbs; round k is played at
  start + step·(k−1). Each round is worth its problem's rating in points.
*/
export const BULLET_DURATIONS_S = [300, 600, 900, 1200, 1800] as const;
export const BULLET_STEPS = [50, 100, 200] as const;
export const BULLET_START = { min: 800, max: 2400 } as const;

export const BATTLE_LIMITS = {
  players: { min: 2, max: 64 },
  tierBase: { min: 800, max: 3000 },
  tierSteps: [100, 200, 300] as readonly number[],
  durationS: { min: 30 * 60, max: 8 * 60 * 60 },
  matchDurationS: 30 * 60,
  /** How far ahead a start may be: not sooner than a minute, not later than
      two weeks. */
  leadS: { min: 60, max: 14 * 24 * 3600 },
} as const;

/** The rating a tier plays at. Mirrors the SQL in the matchmaker. */
export function tierRating(
  battle: { tier_base: number; tier_step: number },
  tier: number,
): number {
  return Math.min(3500, battle.tier_base + (tier - 1) * battle.tier_step);
}
