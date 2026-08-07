"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/*
  The compact, in-card sibling of components/Onboarding: same POST /api/user,
  minus the full-page hero. Lives in Settings so an account that unlinked its
  handle can link one again without going back through the dashboard.
*/
export default function LinkHandle({
  // False where syncing runs on a schedule instead of on demand (no worker).
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
    <div>
      <form onSubmit={submit} className="flex gap-2">
        <label htmlFor="settings-handle" className="sr-only">
          Codeforces handle
        </label>
        <input
          id="settings-handle"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="e.g. mycfhandle"
          autoComplete="off"
          spellCheck={false}
          className="num min-w-0 flex-1 rounded-xl border border-line bg-page px-3 py-2 text-sm placeholder:font-sans placeholder:text-muted/60"
        />
        <button
          type="submit"
          disabled={busy || !handle.trim()}
          className="rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Link"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-wa">
          {error}
        </p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        {syncsOnLink
          ? "The first sync pulls your whole history — a few minutes for large profiles."
          : "Your history is mirrored on a schedule, so the dashboard fills in within half an hour."}
      </p>
    </div>
  );
}
