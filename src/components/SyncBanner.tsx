"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/* Shown while a sync runs; polls status and refreshes the page when done. */
export default function SyncBanner({ initialCount }: { initialCount: number }) {
  const router = useRouter();
  const [count, setCount] = useState(initialCount);
  const done = useRef(false);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/sync");
        if (!res.ok) return;
        const s = await res.json();
        setCount(s.submissions_total ?? 0);
        if (s.status !== "running" && !done.current) {
          done.current = true;
          clearInterval(timer);
          router.refresh();
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [router]);

  return (
    <div className="mb-4 flex items-center gap-3 rounded-(--radius-card) border border-line bg-accent-soft px-4 py-3 text-sm">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2.5 rounded-full bg-accent" />
      </span>
      <span>
        Mirroring your Codeforces history —{" "}
        <span className="num font-semibold">{count.toLocaleString()}</span>{" "}
        submissions so far. The map fills in when it finishes.
      </span>
    </div>
  );
}
