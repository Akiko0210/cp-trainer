"use client";

import { useLayoutEffect, useRef, useState } from "react";

/*
  Rank-change motion, shared by every board.

  FLIP: measure each row's box before the DOM updates and again after, apply the
  inverse transform, then release it — the row physically travels from its old
  rank to its new one, so someone watching sees the overtake happen instead of
  noticing a different list. Alongside it, a map of "how many places did this
  row just move", which the caller turns into a ▲2 / ▼1 badge.

  This lives in one place because two of its three details are the kind that
  look like nothing and break everything:

  * offsetTop, not getBoundingClientRect().top. The rect is viewport-relative,
    so any scroll between two renders makes every stored position stale and
    gives every row a bogus transform.
  * A background tab never runs requestAnimationFrame, so the release half of
    the FLIP would never fire and every moved row would sit at its inverted
    offset until the viewer came back — to a list that looks shuffled. Nothing
    to animate for someone who isn't looking, so when hidden we just take the
    new order.

  Rows must carry `data-user-id` and `data-rank`.
*/
export function useRankMotion<T extends HTMLElement>(rows: unknown[]) {
  const containerRef = useRef<T>(null);
  // Previous geometry and ranks, keyed by row id.
  const boxes = useRef<Map<number, number>>(new Map());
  const prevRank = useRef<Map<number, number>>(new Map());
  const [deltas, setDeltas] = useState<Map<number, number>>(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = !reduce && document.visibilityState === "visible";
    const moved = new Map<number, number>();

    for (const el of Array.from(container.children) as HTMLElement[]) {
      const id = Number(el.dataset.userId);
      const top = el.offsetTop;
      const before = boxes.current.get(id);

      if (before != null && Math.abs(before - top) > 1 && animate) {
        // Invert to the old position, then let it travel to the new one.
        el.style.transition = "none";
        el.style.transform = `translateY(${before - top}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 620ms cubic-bezier(0.22, 1, 0.36, 1)";
          el.style.transform = "";
        });
      }
      boxes.current.set(id, top);

      const rankNow = Number(el.dataset.rank);
      const rankBefore = prevRank.current.get(id);
      if (rankBefore != null && rankBefore !== rankNow) {
        moved.set(id, rankBefore - rankNow); // positive = climbed
      }
      prevRank.current.set(id, rankNow);
    }

    if (moved.size > 0) {
      // Deferred out of the layout pass: the badges are decoration on top of
      // geometry that has already been measured, and writing state
      // synchronously here would mean re-rendering mid-measurement. A timeout
      // rather than a frame, so this still resolves in a background tab.
      const show = setTimeout(() => setDeltas(moved), 0);
      const clear = setTimeout(() => setDeltas(new Map()), 2400);
      return () => {
        clearTimeout(show);
        clearTimeout(clear);
      };
    }
  }, [rows]);

  return { containerRef, deltas };
}
