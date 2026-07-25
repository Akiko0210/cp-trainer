import { redirect } from "next/navigation";
import SolveClient from "./SolveClient";
import { getCurrentUser, getOpenAttempt, getPickerTopics } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function SolvePage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  const { topic } = await searchParams;
  const [topics, openAttempt] = await Promise.all([
    getPickerTopics(user.id),
    getOpenAttempt(user.id),
  ]);
  return (
    <SolveClient
      topics={topics}
      initialTopic={topic ?? null}
      openAttempt={openAttempt}
    />
  );
}
