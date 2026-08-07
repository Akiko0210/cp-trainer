"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/*
  Unlinking is a two-step, and says what will happen before it happens: the
  mirrored CF history and topic mastery go with the handle (they are that
  handle's judge record, not this account's — see lib/cf-account), which is
  worth knowing *before* you click rather than after.
*/
export default function UnlinkHandle({ handle }: { handle: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlink() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/user", { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Unlinking failed.");
      setBusy(false);
      return;
    }
    setBusy(false);
    router.refresh();
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="text-xs text-muted underline underline-offset-2 hover:text-ink"
      >
        Unlink
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-3 text-xs">
      <span className="max-w-56 text-right text-muted">
        Unlink <span className="num">{handle}</span>? Your mirrored CF history
        and topic mastery are removed. Attempts, mistake tags and Kattis solves
        stay.
      </span>
      <button
        onClick={unlink}
        disabled={busy}
        className="rounded-lg border border-line px-3 py-1.5 font-medium text-wa hover:bg-card-2 disabled:opacity-50"
      >
        {busy ? "Unlinking…" : "Unlink"}
      </button>
      <button
        onClick={() => setConfirming(false)}
        className="text-muted underline underline-offset-2 hover:text-ink"
      >
        Cancel
      </button>
      {error && (
        <p role="alert" className="w-full text-right text-wa">
          {error}
        </p>
      )}
    </div>
  );
}
