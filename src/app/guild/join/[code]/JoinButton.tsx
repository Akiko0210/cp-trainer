"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function JoinButton({ code }: { code: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/guild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setBusy(false);
      return setError(body?.error ?? "That didn't work.");
    }
    router.push("/guild");
  }

  return (
    <>
      <button
        onClick={join}
        disabled={busy}
        className="mt-4 w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Joining…" : "Join guild"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-wa">
          {error}
        </p>
      )}
    </>
  );
}
