"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, Label } from "@/components/ui";
import type { Group } from "@/lib/group-queries";

export default function GroupsClient({ groups }: { groups: Group[] }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"join" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(kind: "join" | "create") {
    setBusy(kind);
    setError(null);
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind === "join" ? { code } : { name }),
    });
    const body = await res.json().catch(() => null);
    setBusy(null);
    if (!res.ok) return setError(body?.error ?? "That didn't work.");
    router.push(`/groups/${body.slug}`);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {groups.length > 0 && (
        <Card className="lg:col-span-2">
          <Label>Your groups</Label>
          <ul className="flex flex-col gap-1.5">
            {groups.map((g) => (
              <li key={g.id}>
                <Link
                  href={`/groups/${g.slug}`}
                  className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-card-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {g.name}
                    </span>
                    {g.description && (
                      <span className="block truncate text-xs text-muted">
                        {g.description}
                      </span>
                    )}
                  </span>
                  {g.role !== "member" && (
                    <span className="rounded-md bg-card-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                      {g.role}
                    </span>
                  )}
                  <span className="num shrink-0 text-xs text-muted">
                    {g.member_count} member{g.member_count === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <Label>Join a group</Label>
        <p className="mb-3 text-[13px] leading-relaxed text-muted">
          Got a code from your club? Codes are eight characters, no ambiguous
          letters — readable off a whiteboard.
        </p>
        <div className="flex gap-2">
          <label htmlFor="code" className="sr-only">
            Invite code
          </label>
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
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
        <Label>Start a group</Label>
        <p className="mb-3 text-[13px] leading-relaxed text-muted">
          You&apos;ll be the owner and get a code to share. Everyone who joins
          appears on the leaderboards.
        </p>
        <div className="flex gap-2">
          <label htmlFor="name" className="sr-only">
            Group name
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="SJSU Competitive Programming"
            maxLength={80}
            className="min-w-0 flex-1 rounded-xl border border-line bg-page px-3 py-2.5 text-sm placeholder:text-muted/60"
          />
          <button
            onClick={() => submit("create")}
            disabled={busy !== null || name.trim().length < 2}
            className="shrink-0 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {busy === "create" ? "Creating…" : "Create"}
          </button>
        </div>
      </Card>

      {error && (
        <p role="alert" className="text-sm text-wa lg:col-span-2">
          {error}
        </p>
      )}
    </div>
  );
}
