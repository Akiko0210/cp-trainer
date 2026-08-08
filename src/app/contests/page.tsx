import { redirect } from "next/navigation";
import ContestBoard from "@/components/ContestBoard";
import { workerConfigured } from "@/lib/env";
import { getCurrentUser, getUpcomingContests } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ContestsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  // The whole board, not a page of it: the calendar is a few dozen rows even
  // with every judge on, and the filters are client-side so they can respond
  // without a round trip.
  const contests = await getUpcomingContests(null);

  return (
    <div className="pt-6">
      <div className="mb-5">
        <h1 className="font-display text-[26px] font-semibold tracking-tight">
          Upcoming contests
        </h1>
        <p className="mt-1 text-sm text-muted">
          Every scheduled round the worker mirrors, in your timezone. Turn on
          reminders to be told 15 minutes before one starts.
        </p>
      </div>

      <ContestBoard contests={contests} workerConfigured={workerConfigured()} />
    </div>
  );
}
