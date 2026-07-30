import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser, oauthConfigured } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSessionUser()) redirect("/");
  const { error } = await searchParams;
  const configured = oauthConfigured();

  return (
    <div className="mx-auto mt-20 max-w-md">
      <div className="rounded-(--radius-card) border border-line bg-card p-8">
        <div className="num mb-5 inline-block rounded-lg bg-accent px-2.5 py-1.5 text-sm font-bold text-accent-ink">
          {"//"}
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Sign in to CP Trainer
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Your training data is yours alone. Signing in is what makes a shared
          club leaderboard possible — and it&apos;s GitHub, so no password ever
          touches this app.
        </p>

        {configured ? (
          <a
            href="/api/auth/signin"
            className="mt-6 flex items-center justify-center gap-2.5 rounded-xl bg-ink px-4 py-3 text-[15px] font-medium text-page transition-opacity hover:opacity-90"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.07-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            Continue with GitHub
          </a>
        ) : (
          <div className="mt-6 rounded-xl border border-line bg-page p-4 text-sm">
            <a
              href="/api/auth/local"
              className="mb-4 flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-[15px] font-medium text-accent-ink hover:opacity-90"
            >
              Continue as local user
            </a>
            <p className="mb-4 text-xs leading-relaxed text-muted">
              Available because this is <code className="num">next dev</code>{" "}
              and no OAuth app is configured — it signs you into the local
              account holding your mirrored history. It disappears the moment
              real credentials exist, and never exists in production.
            </p>
            <p className="font-medium">To share this with your club</p>
            <p className="mt-2 leading-relaxed text-muted">
              Register an OAuth app at{" "}
              <a
                href="https://github.com/settings/developers"
                target="_blank"
                rel="noreferrer"
                className="text-accent underline underline-offset-2"
              >
                github.com/settings/developers
              </a>{" "}
              with callback URL{" "}
              <code className="num text-xs">
                http://localhost:3000/api/auth/callback
              </code>
              , then put the id and secret in <code className="num">.env</code>:
            </p>
            <pre className="num mt-3 overflow-x-auto rounded-lg bg-card-2 p-3 text-[11px] leading-relaxed">
{`GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...`}
            </pre>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-wa">
            {error === "state"
              ? "That sign-in attempt expired. Try again."
              : error === "unconfigured"
                ? "GitHub sign-in isn't configured yet."
                : error}
          </p>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-muted">
        Only your GitHub name, avatar and login are stored.{" "}
        <Link href="/" className="underline underline-offset-2">
          Back
        </Link>
      </p>
    </div>
  );
}
