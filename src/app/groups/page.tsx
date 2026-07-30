import { redirect } from "next/navigation";
import GroupsClient from "./GroupsClient";
import { getSessionUser } from "@/lib/auth";
import { getMyGroups } from "@/lib/group-queries";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  const groups = await getMyGroups(user.id);

  return (
    <div className="pt-6">
      <div className="mb-5">
        <h1 className="font-display text-[26px] font-semibold tracking-tight">
          Groups
        </h1>
        <p className="mt-1 text-sm text-muted">
          Train alongside your club. Standings update the moment someone solves
          something.
        </p>
      </div>
      <GroupsClient groups={groups} />
    </div>
  );
}
