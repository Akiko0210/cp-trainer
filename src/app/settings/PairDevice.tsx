"use client";

import { useState } from "react";

/*
  Pair the menu bar app.

  The token appears once, with the two commands that install it, because
  copying a 43-character string by eye is how people end up disabling the thing
  instead of setting it up.
*/
export default function PairDevice() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const commands = token
    ? `defaults write local.cptrainer.streak baseURL ${origin}\n` +
      `defaults write local.cptrainer.streak deviceToken ${token}`
    : "";

  async function pair() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "menu bar app" }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("Pairing failed. Reload and try again.");
      return;
    }
    setToken((await res.json()).token);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(commands);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked; the commands are on screen either way.
    }
  }

  if (!token) {
    return (
      <div>
        <button
          onClick={pair}
          disabled={busy}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Pairing…" : "Pair the menu bar app"}
        </button>
        {error && (
          <p role="alert" className="mt-2 text-sm text-wa">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-2 text-[13px] leading-relaxed text-muted">
        Run these two lines, then restart CPStreak. The token is shown once —
        pair again if you lose it, which replaces the old one.
      </p>
      <pre className="num overflow-x-auto rounded-lg bg-card-2 p-3 text-[11px] leading-relaxed">
        {commands}
      </pre>
      <button
        onClick={copy}
        className="mt-2 rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:bg-card-2"
      >
        {copied ? "Copied" : "Copy both lines"}
      </button>
    </div>
  );
}
