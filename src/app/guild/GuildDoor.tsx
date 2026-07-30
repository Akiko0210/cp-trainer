"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, Label } from "@/components/ui";

/*
  What you see before you belong to one.

  Joining is deliberately the first and larger option: most people arrive with a
  code from a club, and only one person per club ever needs the "found a guild"
  path. Both make the one-guild rule plain up front, because it's the rule that
  makes the rest of the feature work.
*/
export default function GuildDoor() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [busy, setBusy] = useState<"join" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(kind: "join" | "create") {
    setBusy(kind);
    setError(null);
    const res = await fetch("/api/guild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind === "join" ? { code } : { name, tagline }),
    });
    const body = await res.json().catch(() => null);
    setBusy(null);
    if (!res.ok) return setError(body?.error ?? "That didn't work.");
    // Server components hold the guild, the chip and the crown badges, so a
    // plain refresh is what makes all of them appear at once.
    router.refresh();
  }

  return (
    <div className="pt-6">
      <div className="mb-5 max-w-xl">
        <h1 className="font-display text-[26px] font-semibold tracking-tight">
          Join a guild
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          A guild is your club — one per person. Once you&apos;re in, its
          standings follow you around the app: who holds each area, where you
          sit, and every change as it happens.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Label>Have a code?</Label>
          <p className="mb-3 text-[13px] leading-relaxed text-muted">
            Eight characters, no ambiguous letters — it survives being read off a
            whiteboard.
          </p>
          <div className="flex gap-2">
            <label htmlFor="code" className="sr-only">
              Invite code
            </label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.trim().length >= 4) submit("join");
              }}
              placeholder="ABCD2345"
              maxLength={12}
              autoComplete="off"
              spellCheck={false}
              className="num min-w-0 flex-1 rounded-xl border border-line bg-page px-3 py-2.5 tracking-[0.18em] placeholder:tracking-normal placeholder:text-muted/60"
            />
            <button
              onClick={() => submit("join")}
              disabled={busy !== null || code.trim().length < 4}
              className="shrink-0 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
            >
              {busy === "join" ? "Joining…" : "Join"}
            </button>
          </div>
        </Card>

        <Card>
          <Label>Or found one</Label>
          <p className="mb-3 text-[13px] leading-relaxed text-muted">
            You&apos;ll lead it and get a code to share. Everyone who joins
            appears on the boards and can take an area off you.
          </p>
          <div className="flex flex-col gap-2">
            <label htmlFor="name" className="sr-only">
              Guild name
            </label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="SJSU Competitive Programming"
              maxLength={80}
              className="rounded-xl border border-line bg-page px-3 py-2.5 text-sm placeholder:text-muted/60"
            />
            <div className="flex gap-2">
              <label htmlFor="tagline" className="sr-only">
                Tagline
              </label>
              <input
                id="tagline"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="NAC bound (optional)"
                maxLength={120}
                className="min-w-0 flex-1 rounded-xl border border-line bg-page px-3 py-2.5 text-sm placeholder:text-muted/60"
              />
              <button
                onClick={() => submit("create")}
                disabled={busy !== null || name.trim().length < 2}
                className="shrink-0 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                {busy === "create" ? "Founding…" : "Found"}
              </button>
            </div>
          </div>
        </Card>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-wa">
          {error}
        </p>
      )}
    </div>
  );
}
