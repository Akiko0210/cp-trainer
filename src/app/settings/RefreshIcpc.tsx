"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RefreshIcpc() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await fetch("/api/icpc/seed", { method: "POST" });
    if (res.ok) {
      setNote(
        "Refreshing in the background — takes a few minutes (Kattis is crawled politely, one page every 2s). Reload to see new sets.",
      );
      router.refresh();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Refresh failed.");
    }
    setBusy(false);
  }

  return (
    <div>
      <button
        onClick={run}
        disabled={busy}
        className="rounded-xl border border-line px-4 py-2.5 text-sm hover:border-accent/50 disabled:opacity-50"
      >
        {busy ? "Starting…" : "Refresh ICPC sets"}
      </button>
      {note && <p className="mt-2 text-xs leading-relaxed text-muted">{note}</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-wa">
          {error}
        </p>
      )}
    </div>
  );
}
