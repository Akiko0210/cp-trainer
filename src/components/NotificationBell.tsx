"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionButton, fmtClock, useNow } from "./arena-ui";
import LocalTime from "./LocalTime";
import { AlertsToggle } from "./live-feed";
import { describe, isLiveChallenge, useInbox } from "./NotificationsProvider";
import type { InboxRow } from "@/lib/notification-queries";

/*
  The bell in the header: an unread count, and a list you can act from.

  Opening it marks every row seen (they will not pop elsewhere now) and
  refetches, so the list is the whole recent inbox and not just what was
  unread at page load. Closing it marks the news read — you looked — but a
  live challenge stays unread until it is answered, withdrawn or expired:
  the badge is not allowed to go quiet while a decision is waiting.

  Badge and dot are the accent, never a verdict colour.
*/

export default function NotificationBell() {
  const inbox = useInbox();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const rows = inbox?.rows ?? [];
  const now = useNow(open && rows.some((r) => r.kind === "duel_challenge" && r.duel_status === "pending"));

  const close = () => {
    setOpen(false);
    if (!inbox) return;
    const nowMs = Date.now();
    inbox.markRead(
      rows.filter((r) => !r.read_at && !isLiveChallenge(r, nowMs)).map((r) => r.id),
    );
  };
  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    if (!inbox) return;
    inbox.markSeen(rows.filter((r) => !r.seen_at).map((r) => r.id));
    void inbox.refresh();
  };

  // Close on outside click / Escape anywhere (the Select's contract).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!inbox) return null;
  const unread = inbox.unread;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative grid size-8 place-items-center rounded-full border border-line bg-card text-muted hover:text-ink"
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden>
          <path
            d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3L4 11Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        {unread > 0 && (
          <span className="num absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-ink">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-1.5 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-card shadow-xl shadow-black/20"
        >
          <ul className="max-h-96 overflow-y-auto p-1">
            {rows.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted">
                Nothing yet. A challenge from a guildmate lands here.
              </li>
            )}
            {rows.map((r) => (
              <Row key={r.id} row={r} now={now} onNavigate={close} />
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
            <AlertsToggle {...inbox.alerts} />
            <button
              type="button"
              onClick={() => inbox.markRead(rows.filter((r) => !r.read_at).map((r) => r.id))}
              disabled={unread === 0}
              className="text-xs text-muted hover:text-ink disabled:opacity-40"
            >
              Mark all read
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  row,
  now,
  onNavigate,
}: {
  row: InboxRow;
  now: number;
  onNavigate: () => void;
}) {
  const inbox = useInbox()!;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = isLiveChallenge(row, now);
  const { title, body } = describe(row, inbox.meId);
  const unread = !row.read_at;

  const answer = async (action: "accept" | "decline") => {
    setBusy(true);
    setError(null);
    const err = await inbox.act(row, action);
    setBusy(false);
    if (err) setError(err);
    else if (action === "accept") {
      onNavigate();
      router.push("/guild/duels");
    }
  };

  const again =
    row.kind === "duel_challenge" &&
    (row.duel_status === "expired" || row.duel_status === "cancelled");

  return (
    <li className={`rounded-lg px-2.5 py-2 ${unread ? "bg-card-2/60" : ""}`}>
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${unread ? "bg-accent" : "bg-transparent"}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={`truncate text-sm ${unread ? "font-medium" : ""}`}>{title}</span>
            <span className="num shrink-0 text-[11px] text-muted">
              <LocalTime iso={row.created_at} mode="daytime" />
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted">{body}</div>
          {live && (
            <div className="mt-2 flex items-center gap-2">
              <ActionButton size="sm" disabled={busy} onClick={() => void answer("accept")}>
                Accept
              </ActionButton>
              <ActionButton size="sm" tone="quiet" disabled={busy} onClick={() => void answer("decline")}>
                Decline
              </ActionButton>
              <span className="num ml-auto text-xs text-muted" title="Expires in">
                {fmtClock(Date.parse(row.expires_at!) - now)}
              </span>
            </div>
          )}
          {!live && (
            <Link
              href="/guild/duels"
              onClick={() => {
                inbox.markRead([row.id]);
                onNavigate();
              }}
              className="mt-1 inline-block text-xs text-accent-dk hover:underline"
            >
              {again ? "Challenge back" : "Open duels"}
            </Link>
          )}
          {error && (
            <p role="alert" className="mt-1 text-xs text-wa">
              {error}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
