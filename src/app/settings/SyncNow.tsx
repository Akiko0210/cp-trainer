"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SyncNow() {
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
