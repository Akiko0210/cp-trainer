"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/*
  Leaving is a two-step, and says what will happen before it happens: a leader
  hands the guild to its longest-standing member on the way out (see
  leaveGuild), which is worth knowing *before* you click rather than after.
*/
export default function LeaveGuild({
  name,
  isLeader,
  lastMember,
}: {
  name: string;
  isLeader: boolean;
  lastMember: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function leave() {
    setBusy(true);
    await fetch("/api/guild", { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="text-xs text-muted underline underline-offset-2 hover:text-ink"
      >
        Leave {name}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <span className="text-muted">
        Leave {name}?{" "}
        {isLeader && !lastMember && (
          <>The next-longest-standing member becomes leader.</>
        )}
        {isLeader && lastMember && (
          <>You&apos;re the last member — the guild will be left empty.</>
        )}
      </span>
      <button
        onClick={leave}
        disabled={busy}
        className="rounded-lg border border-line px-3 py-1.5 font-medium text-wa hover:bg-card-2 disabled:opacity-50"
      >
        {busy ? "Leaving…" : "Leave"}
      </button>
      <button
        onClick={() => setConfirming(false)}
        className="text-muted underline underline-offset-2 hover:text-ink"
      >
        Cancel
      </button>
    </div>
  );
}
