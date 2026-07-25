import { NextResponse } from "next/server";
import { getCurrentUser, recommend } from "@/lib/queries";

// GET /api/recommend?topic=<slug>&skip=<n> — one problem card at a time.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const url = new URL(req.url);
  const topic = url.searchParams.get("topic");
  const skip = Math.max(0, Number(url.searchParams.get("skip") ?? 0) || 0);
  const rec = await recommend(user.id, topic, skip);
  return NextResponse.json(rec);
}
