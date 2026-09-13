"use client";

import { useCallback, useRef, useState } from "react";

/*
  A transient message at the bottom of the screen.

  One implementation for the three places that need it (the solve view, the
  ICPC set view, and the arena's live feed), because the third copy of the
  same fixed-position div is the moment it stops being a snippet. Messages
  stack — a bullet round can close and the next one open in the same refetch,
  and the second must not overwrite the first before it is read.
*/

const SHOW_MS = 3200;
const MAX_STACK = 3;

export type ToastItem = { id: number; text: string };

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const push = useCallback((text: string) => {
    const id = ++next.current;
    setToasts((t) => [...t, { id, text }].slice(-MAX_STACK));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), SHOW_MS);
  }, []);
  return { toasts, push };
}

export function Toasts({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className="feed-in max-w-md rounded-xl border border-line bg-card px-4 py-2.5 text-sm shadow-lg shadow-black/15"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
