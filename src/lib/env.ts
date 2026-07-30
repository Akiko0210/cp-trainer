/*
  Environment, checked once and loudly.

  On localhost a missing variable degrades into something harmless (a default
  connection string, a dev-only sign-in). In production the same missing
  variable is a security hole that boots successfully and looks fine — an app
  with no GITHUB_CLIENT_ID would happily serve the dev sign-in route to the
  internet. So production fails fast instead, at startup, with the name of what
  is missing.
*/

export const isProd = process.env.NODE_ENV === "production";

/** Comma-separated GitHub logins allowed to run operator actions. */
export function adminLogins(): string[] {
  return (process.env.ADMIN_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Operator actions are things that cost real resources or reshape shared data:
 * re-crawling Kattis, reseeding. With no allowlist configured, whoever set the
 * install up — the lowest user id — is the operator, so a solo install works
 * out of the box and a club install can be locked down with one variable.
 */
export function isOperator(user: {
  id: number;
  github_login: string | null;
}): boolean {
  const allow = adminLogins();
  if (allow.length > 0) {
    return !!user.github_login && allow.includes(user.github_login.toLowerCase());
  }
  return user.id === 1;
}

/**
 * Shared secret between the Next app and the Python worker. The worker can
 * trigger a full Codeforces re-sync or a Kattis crawl for any user, so it must
 * never be callable by whoever finds its URL.
 */
export function workerToken(): string | null {
  return process.env.WORKER_TOKEN?.trim() || null;
}

const REQUIRED_IN_PROD = [
  "DATABASE_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "WORKER_TOKEN",
] as const;

/**
 * Called from instrumentation.ts, so a misconfigured deploy dies at boot rather
 * than at the first sign-in attempt.
 */
export function assertProductionEnv(): void {
  if (!isProd) return;
  // `next build` runs with NODE_ENV=production and loads this module. A build
  // machine legitimately has no database or OAuth secret, and failing there
  // would make the image impossible to produce.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const missing = REQUIRED_IN_PROD.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s) in production: ${missing.join(", ")}. ` +
        `See DEPLOY.md — the app refuses to start half-configured.`,
    );
  }
}
