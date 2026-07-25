import { redirect } from "next/navigation";
import { Card, Label } from "@/components/ui";
import { one } from "@/lib/db";
import { getCurrentUser, getSyncState } from "@/lib/queries";
import RefreshIcpc from "./RefreshIcpc";
import SyncNow from "./SyncNow";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  const [sync, icpc] = await Promise.all([
    getSyncState(user.id),
    one<{ sets: number; problems: number }>(
      `select (select count(*) from contest_sets)::int as sets,
              (select count(*) from contest_set_problems)::int as problems`,
    ),
  ]);

  return (
    <div className="mx-auto max-w-xl pt-6">
      <h1 className="font-display mb-5 text-[26px] font-semibold tracking-tight">
        Settings
      </h1>

      <Card className="mb-4">
        <Label>Codeforces account</Label>
        <div className="flex items-center justify-between">
          <div>
            <div className="num text-lg font-semibold">{user.cf_handle}</div>
            <div className="mt-0.5 text-sm text-muted">
              {user.cf_rank ?? "unrated"} ·{" "}
              <span className="num">{user.cf_rating ?? "—"}</span>
              {user.cf_max_rating && (
                <>
                  {" "}
                  (max <span className="num">{user.cf_max_rating}</span>)
                </>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <Label>Sync</Label>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Status</dt>
          <dd className="text-right">
            {sync?.status === "ok" && "up to date"}
            {sync?.status === "running" && "running…"}
            {sync?.status === "error" && <span className="text-wa">failed</span>}
            {!sync?.status && "never ran"}
          </dd>
          <dt className="text-muted">Last run</dt>
          <dd className="num text-right">
            {sync?.last_run_at ? new Date(sync.last_run_at).toLocaleString() : "—"}
          </dd>
          <dt className="text-muted">Mirrored submissions</dt>
          <dd className="num text-right">
            {(sync?.submissions_total ?? 0).toLocaleString()}
          </dd>
        </dl>
        {sync?.status === "error" && sync.message && (
          <p className="mt-3 rounded-lg bg-wa-soft px-3 py-2 text-xs text-wa">
            {sync.message}
          </p>
        )}
        <div className="mt-4">
          <SyncNow />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          The worker also syncs on its own every 30 minutes while running.
          Solves made outside the app count too — the mirror is your full CF
          history.
        </p>
      </Card>

      <Card className="mt-4">
        <Label>ICPC archive</Label>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Contest sets</dt>
          <dd className="num text-right">{icpc?.sets ?? 0}</dd>
          <dt className="text-muted">Problems</dt>
          <dd className="num text-right">
            {(icpc?.problems ?? 0).toLocaleString()}
          </dd>
        </dl>
        <div className="mt-4">
          <RefreshIcpc />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Kattis publishes a new regional season about once a year, so this is a
          manual refresh rather than a schedule. Kattis has no public API and
          disallows profile scraping, so your solves there are recorded by the
          app&apos;s own timer, never mirrored.
        </p>
      </Card>
    </div>
  );
}
