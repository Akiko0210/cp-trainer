import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getOpenSession, getSetDetail } from "@/lib/icpc-queries";
import { getCurrentUser } from "@/lib/queries";
import SetClient from "./SetClient";

export const dynamic = "force-dynamic";

export default async function SetPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const detail = await getSetDetail(user.id, decodeURIComponent(slug));
  if (!detail) notFound();

  const open = await getOpenSession(user.id);
  // Only treat the session as this set's contest if it actually is.
  const session = open && open.set_id === detail.set.id ? open : null;

  return (
    <div className="pt-6">
      <nav className="mb-4 text-sm text-muted" aria-label="Breadcrumb">
        <Link href="/icpc" className="hover:text-ink">
          ICPC practice
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink">{detail.set.name}</span>
      </nav>

      {open && !session && (
        <div
          className="mb-4 rounded-(--radius-card) border px-4 py-3 text-sm"
          style={{ borderColor: "var(--icpc)", backgroundColor: "var(--icpc-soft)" }}
        >
          You have a contest running on{" "}
          <Link
            href={`/icpc/${encodeURIComponent(open.set_slug)}`}
            className="font-medium underline underline-offset-2"
          >
            {open.set_name}
          </Link>
          . Finish it before starting another.
        </div>
      )}

      <SetClient
        set={detail.set}
        problems={detail.problems}
        session={session}
        otherContestRunning={!!open && !session}
      />
    </div>
  );
}
