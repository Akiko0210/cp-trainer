"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function Onboarding({
  /*
    False where syncing runs on a schedule instead of on demand. The link
    succeeds either way; what differs is whether anything appears immediately.
    Someone who links a handle and lands on an empty dashboard with no
    explanation assumes it's broken and doesn't come back.
  */
  syncsOnLink = true,
}: {
  syncsOnLink?: boolean;
}) {
  const router = useRouter();
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!handle.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: handle.trim() }),
    });
    if (res.ok) {
      router.refresh();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-md">
      <div className="rounded-(--radius-card) border border-line bg-card p-8">
        <div className="num mb-5 inline-block rounded-lg bg-accent px-2.5 py-1.5 text-sm font-bold text-accent-ink">
          {"//"}
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Link your Codeforces handle
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          CP Trainer mirrors your full submission history and keeps it current
          — every solve counts toward topic mastery, even ones made outside the
          app. No password needed; the CF API is public.
        </p>
        <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
          <label htmlFor="handle" className="sr-only">
            Codeforces handle
          </label>
          <input
            id="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="e.g. mycfhandle"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="num rounded-xl border border-line bg-page px-4 py-3 text-[15px] placeholder:font-sans placeholder:text-muted/60"
          />
          <button
            type="submit"
            disabled={busy || !handle.trim()}
            className="rounded-xl bg-accent px-4 py-3 text-[15px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Checking handle…" : "Link handle"}
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-3 text-sm text-wa">
            {error}
          </p>
        )}
      </div>
      <p className="mt-4 text-center text-xs leading-relaxed text-muted">
        {syncsOnLink ? (
          <>
            The first sync pulls your whole history — a few minutes for large
            profiles (the CF API allows ~1 request per 2s).
          </>
        ) : (
          <>
            Your history is mirrored on a schedule, so the dashboard fills in
            within the hour rather than straight away. Nothing else to do —
            solves made outside the app count too.
          </>
        )}
      </p>
    </div>
  );
}
