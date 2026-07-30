"use client";

import { useState } from "react";

export default function InviteCode({
  slug,
  code: initial,
}: {
  slug: string;
  code: string;
}) {
  const [code, setCode] = useState(initial);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked; the code is visible either way.
    }
  }

  async function rotate() {
    if (busy) return;
    setBusy(true);
    const res = await fetch(`/api/groups/${slug}/invite`, { method: "POST" });
    if (res.ok) setCode((await res.json()).invite_code);
    setBusy(false);
  }

  return (
    <div className="text-right">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
        Invite code
      </div>
      <button
        onClick={copy}
        title="Copy to clipboard"
        className="num mt-1 block rounded-lg border border-line bg-card px-3 py-2 text-lg font-semibold tracking-[0.18em] hover:border-accent/50"
      >
        {code}
      </button>
      <div className="mt-1 flex items-center justify-end gap-3 text-[11px]">
        <span className={copied ? "text-accent" : "text-muted"}>
          {copied ? "Copied" : "Click to copy"}
        </span>
        <button
          onClick={rotate}
          disabled={busy}
          className="text-muted underline underline-offset-2 hover:text-ink disabled:opacity-50"
        >
          {busy ? "…" : "Rotate"}
        </button>
      </div>
    </div>
  );
}
