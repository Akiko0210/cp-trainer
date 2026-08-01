"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SyncNow({
  /*
    False on a serverless deployment, where there is no worker process to poke
    and syncing runs on a schedule instead. A button that can only return an
    error teaches people the app is broken; saying what actually happens
    teaches them to wait.
  */
  scheduled = false,
}: {
  scheduled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/sync", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Sync failed.");
    }
    setBusy(false);
    router.refresh();
  }

  if (scheduled) {
    return (
      <p className="rounded-lg bg-card-2 px-3 py-2.5 text-[13px] leading-relaxed text-muted">
        This deployment refreshes every member&apos;s Codeforces history on a
        schedule — new solves appear within half an hour. There is nothing to
        trigger by hand.
      </p>
    );
  }

  return (
    <div>
      <button
        onClick={run}
        disabled={busy}
        className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Starting…" : "Sync now"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-wa">
          {error}
        </p>
      )}
    </div>
  );
}
