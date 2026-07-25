"use client";

export default function ThemeToggle() {
  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    localStorage.theme = next ? "dark" : "light";
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle color theme"
      className="grid size-8 place-items-center rounded-full border border-line bg-card text-muted hover:text-ink"
    >
      {/* render both, hide via CSS to avoid hydration mismatch */}
      <svg
        viewBox="0 0 16 16"
        className="hidden size-4 dark:block"
        fill="currentColor"
        aria-hidden
      >
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
        <circle cx="8" cy="8" r="3" />
      </svg>
      <svg viewBox="0 0 16 16" className="size-4 dark:hidden" fill="currentColor" aria-hidden>
        <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7Z" />
      </svg>
    </button>
  );
}
