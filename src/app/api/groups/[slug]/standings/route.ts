import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getGroup, getGroupActivity, getStandings, type Board } from "@/lib/group-queries";

export const dynamic = "force-dynamic";

// Fetched on load and re-fetched when the SSE stream says something moved.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { slug } = await params;
  const group = await getGroup(slug, user.id);
  if (!group) return NextResponse.json({ error: "No such group." }, { status: 404 });
  if (!group.role) {
    return NextResponse.json({ error: "Join the group first." }, { status: 403 });
  }

  const url = new URL(req.url);
  const board = (url.searchParams.get("board") ?? "elo") as Board;
  const category = url.searchParams.get("category") ?? undefined;

  const [standings, activity] = await Promise.all([
    getStandings(group.id, board, category),
    getGroupActivity(group.id, 12),
  ]);

  return NextResponse.json(
    { standings, activity, board, category: category ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
