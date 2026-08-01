import { redirect } from "next/navigation";
import { Card, Label } from "@/components/ui";
import { one } from "@/lib/db";
import { workerConfigured } from "@/lib/env";
import { getCurrentUser, getSyncState } from "@/lib/queries";
import PairDevice from "./PairDevice";
import RefreshIcpc from "./RefreshIcpc";
import SyncNow from "./SyncNow";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const worker = workerConfigured();
  const [sync, icpc] = await Promise.all([
    getSyncState(user.id),
    one<{ sets: number; problems: number }>(
      `select (select count(*) from contest_sets)::int as sets,
              (select count(*) from contest_set_problems)::int as problems`,
    ),
  ]);

  const stale = sync?.stale ?? false;

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
            {sync?.status === "ok" &&
              (stale ? <span className="text-muted">stale</span> : "up to date")}
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
        {stale && (
          <p className="mt-3 rounded-lg bg-card-2 px-3 py-2 text-xs text-muted">
            No sync has completed in over two hours — the schedule has likely
            stopped. New solves will not appear until it runs again; the
            operator can check the repository&apos;s Actions tab.
          </p>
        )}
        <div className="mt-4">
          <SyncNow scheduled={!worker} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {worker
            ? "The worker also syncs on its own every 30 minutes while running. "
            : "Syncing runs every half hour on a schedule. "}
          Solves made outside the app count too — the mirror is your full CF
          history.
        </p>
      </Card>

      <Card className="mt-4">
        <Label>Menu bar app</Label>
        <p className="mb-3 text-[13px] leading-relaxed text-muted">
          The macOS menu bar readout keeps your streak visible without opening
          the site. It isn&apos;t a browser, so it can&apos;t use your sign-in —
          pair it once with a token of its own, revocable from here.
        </p>
        <PairDevice />
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
          <RefreshIcpc available={worker} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Kattis publishes a new regional season about once a year, so this is
          a manual refresh rather than a schedule. Kattis has no public API and
          disallows profile scraping, so your solves there are recorded by the
          app&apos;s own timer, never mirrored.
        </p>
      </Card>
    </div>
  );
}
