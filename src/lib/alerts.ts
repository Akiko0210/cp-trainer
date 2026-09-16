/*
  Getting someone's attention when they are not looking at this tab.

  Three escalating signals, all client-side: the title flashes, a browser
  notification (if permitted), and a short chime. They used to live inside
  the arena feed; the header's inbox needs the same three, and importing the
  whole feed module into the nav for them was the wrong dependency.

  "Not looking" is `isAway()`: the tab is hidden OR the window has lost
  focus. The second half matters more than it sounds — the real bullet setup
  is Codeforces in one window and this app in the other, side by side, where
  `visibilityState` stays "visible" the whole race and the old hidden-only
  check never fired.
*/

let audio: AudioContext | null = null;

/** Called from a user gesture (a click), because a context made outside one
    starts suspended and a hidden tab can't resume it. */
export function armChime(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    audio = null;
  }
}

export function chime(): void {
  if (!audio) return;
  try {
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1174.66, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.start(t);
    osc.stop(t + 0.42);
  } catch {
    // No sound is not a failure.
  }
}

let originalTitle: string | null = null;
export function flashTitle(text: string): void {
  if (originalTitle === null) originalTitle = document.title;
  document.title = `● ${text}`;
  const restore = () => {
    if (isAway()) return;
    if (originalTitle !== null) document.title = originalTitle;
    originalTitle = null;
    document.removeEventListener("visibilitychange", restore);
    window.removeEventListener("focus", restore);
  };
  document.addEventListener("visibilitychange", restore);
  // A side-by-side window comes back by focus, never by visibilitychange.
  window.addEventListener("focus", restore);
}

/** True when the viewer would not see something appear on this page. */
export function isAway(): boolean {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

/**
 * The full escalation, only when the viewer is away: the in-page surface
 * (toast, popup) is the caller's job and always shows. `notify` is the
 * per-feature opt-in — a Notification without permission throws, and a chime
 * nobody asked for is the fastest way to get the whole site muted.
 */
export function notifyAway(
  title: string,
  body: string,
  tag: string,
  opts: { notify: boolean },
): void {
  if (!isAway()) return;
  flashTitle(body);
  if (!opts.notify) return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => window.focus();
  } catch {
    // Permission revoked since the toggle — the in-page surface still shows.
  }
  chime();
}

/**
 * Ask for notification permission from inside a click. Synchronous on
 * purpose: Safari treats the gesture as spent after the first await, so
 * this has to run before the caller's fetch, not after it.
 */
export function requestNotifyPermission(): void {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => {});
}
