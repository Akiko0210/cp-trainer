"use client";

import { useEffect, useId, useRef, useState } from "react";

/*
  A designed replacement for the native <select>, which renders as an OS
  widget that ignores the app's tokens entirely.

  Keeps the keyboard contract a real listbox has, because losing that would be
  a worse regression than the styling gain: Enter/Space/ArrowDown opens,
  Arrow keys move, Home/End jump, typing jumps to a match, Enter picks, Escape
  closes and restores focus to the trigger.
*/

export type SelectOption = { value: string; label: string; hint?: string };
export type SelectGroup = { label: string; options: SelectOption[] };

export default function Select({
  value,
  onChange,
  options,
  groups,
  placeholder = "Select…",
  ariaLabel,
  className = "",
  accent = "var(--accent)",
}: {
  value: string;
  onChange: (value: string) => void;
  options?: SelectOption[];
  groups?: SelectGroup[];
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  accent?: string;
}) {
  const flat: SelectOption[] = groups
    ? groups.flatMap((g) => g.options)
    : (options ?? []);
  const selected = flat.find((o) => o.value === value);

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() =>
    Math.max(0, flat.findIndex((o) => o.value === value)),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ buffer: "", at: 0 });
  const listId = useId();

  // Close on outside click / Escape anywhere.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the active option in view as the user arrows through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function commit(idx: number) {
    const opt = flat[idx];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
    (rootRef.current?.querySelector("button") as HTMLButtonElement)?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
        setActive(Math.max(0, flat.findIndex((o) => o.value === value)));
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(flat.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(flat.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(active);
        break;
      default:
        if (e.key.length === 1) {
          // Type-ahead: consecutive keystrokes build a prefix.
          const now = Date.now();
          typed.current.buffer =
            now - typed.current.at > 800
              ? e.key.toLowerCase()
              : typed.current.buffer + e.key.toLowerCase();
          typed.current.at = now;
          const hit = flat.findIndex((o) =>
            o.label.toLowerCase().startsWith(typed.current.buffer),
          );
          if (hit >= 0) setActive(hit);
        }
    }
  }

  // Each option needs its index in the flattened list (that's what the
  // keyboard cursor moves through). Computed with cumulative offsets rather
  // than a counter mutated mid-render.
  const rendered = groups ?? [{ label: "", options: options ?? [] }];
  const offsets = rendered.reduce<number[]>(
    (acc, g, i) => [...acc, acc[i] + g.options.length],
    [0],
  );

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          setOpen((o) => !o);
          setActive(Math.max(0, flat.findIndex((o) => o.value === value)));
        }}
        onKeyDown={onKeyDown}
        className="flex w-full items-center gap-2 rounded-(--radius-chip) border border-line bg-card px-3 py-2 text-left text-sm transition-colors hover:border-accent/50"
      >
        <span
          className={`min-w-0 flex-1 truncate ${selected ? "" : "text-muted"}`}
        >
          {selected?.label ?? placeholder}
        </span>
        <svg
          viewBox="0 0 12 12"
          aria-hidden
          className={`size-3 shrink-0 text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        >
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="absolute z-50 mt-1.5 max-h-72 w-full min-w-max overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-xl shadow-black/20"
        >
          {rendered.map((group, gi) => (
            <li key={group.label || "_"}>
              {group.label && (
                <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                  {group.label}
                </div>
              )}
              <ul role="none">
                {group.options.map((opt, k) => {
                  const idx = offsets[gi] + k;
                  const isActive = idx === active;
                  const isSelected = opt.value === value;
                  return (
                    <li
                      key={opt.value}
                      role="option"
                      aria-selected={isSelected}
                      data-idx={idx}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => commit(idx)}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                        isActive ? "bg-card-2" : ""
                      }`}
                    >
                      <span
                        className="w-1 shrink-0 self-stretch rounded-full"
                        style={{
                          backgroundColor: isSelected ? accent : "transparent",
                        }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                      {opt.hint && (
                        <span className="num shrink-0 text-xs text-muted">
                          {opt.hint}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
