"use client";

import { useState } from "react";

export default function InviteCode({ code: initial }: { code: string }) {
  const [code, setCode] = useState(initial);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [busy, setBusy] = useState(false);

  async function copy(what: "code" | "link") {
    const text =
      what === "code" ? code : `${window.location.origin}/guild/join/${code}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      // Clipboard can be blocked; the code is on screen either way.
    }
  }

  async function rotate() {
    if (busy) return;
    setBusy(true);
    const res = await fetch("/api/guild/invite", { method: "POST" });
    if (res.ok) setCode((await res.json()).invite_code);
    setBusy(false);
  }

  return (
    <div className="text-right">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
        Invite code
      </div>
      <button
        onClick={() => copy("code")}
        title="Copy the code"
        className="num mt-1 block w-full rounded-lg border border-line bg-card px-3 py-2 text-lg font-semibold tracking-[0.18em] hover:border-accent/50"
      >
        {code}
      </button>
      <div className="mt-1.5 flex items-center justify-end gap-3 text-[11px]">
        <span className={copied ? "text-accent" : "text-muted"}>
          {copied === "code"
            ? "Code copied"
            : copied === "link"
              ? "Link copied"
              : "Click to copy"}
        </span>
        {/* A link is what actually gets pasted into a club Discord. */}
        <button
          onClick={() => copy("link")}
          className="text-muted underline underline-offset-2 hover:text-ink"
        >
          Copy link
        </button>
        <button
          onClick={rotate}
          disabled={busy}
          title="Replace the code — old ones stop working"
          className="text-muted underline underline-offset-2 hover:text-ink disabled:opacity-50"
        >
          {busy ? "…" : "Rotate"}
        </button>
      </div>
    </div>
  );
}
