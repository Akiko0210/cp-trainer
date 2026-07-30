/*
  The flame, in one place.

  It appears at three sizes now — 32px in the dashboard hero, 13px in the nav
  chip, and as an SF Symbol in the menu bar app — and a streak that looked like
  a different flame in each spot would stop reading as one thing. The inner
  tongue is optional: below about 20px it's mud, so the chip draws the
  silhouette alone.
*/
export function FlameGlyph({
  size = 16,
  outer = "currentColor",
  inner,
  outerOpacity = 1,
}: {
  size?: number;
  outer?: string;
  /** Second, hotter tongue. Omit at small sizes. */
  inner?: string;
  outerOpacity?: number;
}) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        d="M12 2c.7 3.2-1.4 4.6-2.8 6.1C7.6 9.9 6 11.6 6 14.4A6 6 0 0 0 18 15c0-3.6-2.3-5.2-3.6-7.2-.6-.9-1-1.9-.9-3.1-1 .6-1.8 1.4-2.3 2.4C10.9 5.6 11.6 3.8 12 2Z"
        fill={outer}
        opacity={outerOpacity}
      />
      {inner && (
        <path
          d="M12 12c.4 1.6-.7 2.3-1.4 3-.8.9-1.6 1.8-1.6 3.2A3 3 0 0 0 15 18.6c0-1.8-1.2-2.6-1.8-3.6-.3-.5-.5-1-.5-1.6-.5.3-.9.7-1.1 1.2-.1-.9.2-1.8.4-2.6Z"
          fill={inner}
          opacity={0.65}
        />
      )}
    </svg>
  );
}
