"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionButton, fmtClock, useNow } from "./arena-ui";
import { describe, isLiveChallenge, useInbox } from "./NotificationsProvider";
import { isAway } from "@/lib/alerts";
import type { InboxRow } from "@/lib/notification-queries";

/*
  The top-right cards: what just happened, where you are, whatever page.

  A challenge is a decision, so its card stays — with the clock it is on and
  Accept / Decline right there — until you answer, it is withdrawn, or the
  five minutes run out. Everything else is news and leaves on its own after a
  few seconds, but only seconds you were looking: a card that appears while
  you are in another window waits for you to come back before it counts.

  Anchored below the header by measuring it: on a phone the header wraps to
  two rows, and a fixed offset would sit the first card over the nav links.
*/

const NEWS_S = 8;

export default function NotificationPopups() {
  const inbox = useInbox();
  const [top, setTop] = useState(72);
  useEffect(() => {
    const header = document.querySelector("header");
    if (!header) return;
    const measure = () => setTop(header.getBoundingClientRect().height + 8);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  if (!inbox || inbox.popups.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ top }}
      className="fixed right-4 z-50 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {inbox.popups.map((r) => (
        <PopupCard key={r.id} row={r} />
      ))}
    </div>
  );
}

function PopupCard({ row }: { row: InboxRow }) {
  const inbox = useInbox()!;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = row.kind === "duel_challenge" && row.duel_status === "pending";
  const now = useNow(live);
  const remaining = row.expires_at ? Date.parse(row.expires_at) - now : 0;
  const { title, body } = describe(row, inbox.meId);
  const dismiss = () => inbox.markRead([row.id]);

  // The decision card leaves when the clock does.
  useEffect(() => {
    if (live && !isLiveChallenge(row, now)) inbox.markRead([row.id]);
  }, [live, now]); // eslint-disable-line react-hooks/exhaustive-deps

  // News leaves after NEWS_S seconds of being looked at.
  const left = useRef(NEWS_S);
  useEffect(() => {
    if (live) return;
    const t = setInterval(() => {
      if (isAway()) return;
      left.current -= 1;
      if (left.current <= 0) inbox.markRead([row.id]);
    }, 1000);
    return () => clearInterval(t);
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (action: "accept" | "decline") => {
    setBusy(true);
    setError(null);
    const err = await inbox.act(row, action);
    setBusy(false);
    if (err) setError(err);
    else if (action === "accept") router.push("/guild/duels");
  };

  const open = () => {
    inbox.markRead([row.id]);
    router.push("/guild/duels");
  };

  return (
    <div className="feed-in relative rounded-xl border border-line bg-card p-3 pr-8 text-sm shadow-lg shadow-black/15">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-2 top-2 grid size-6 place-items-center rounded-full text-muted hover:bg-card-2 hover:text-ink"
      >
        <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        </svg>
      </button>
      {live ? (
        <>
          <div className="font-medium">{title}</div>
          <div className="mt-0.5 text-xs text-muted">{body}</div>
          <div className="mt-2.5 flex items-center gap-2">
            <ActionButton size="sm" disabled={busy} onClick={() => void answer("accept")}>
              Accept — go!
            </ActionButton>
            <ActionButton size="sm" tone="quiet" disabled={busy} onClick={() => void answer("decline")}>
              Decline
            </ActionButton>
            <span className="num ml-auto text-xs text-muted" title="Expires in">
              {fmtClock(remaining)}
            </span>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-xs text-wa">
              {error}
            </p>
          )}
        </>
      ) : (
        <button type="button" onClick={open} className="block w-full text-left">
          <div className="font-medium">{title}</div>
          <div className="mt-0.5 text-xs text-muted">{body}</div>
        </button>
      )}
    </div>
  );
}
