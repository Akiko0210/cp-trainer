import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getCurrentUser } from "@/lib/queries";
import { MISTAKE_TAGS } from "@/lib/taxonomy";

const VALID = new Set(MISTAKE_TAGS.map((t) => t.tag));

// One-tap post-mortem: a set of tags (fixed taxonomy, §6.2) + optional note,
// attached to an attempt the user owns.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No user yet." }, { status: 404 });
  const { attemptId, tags, note } = await req.json().catch(() => ({}));
  const clean = Array.isArray(tags) ? tags.filter((t) => VALID.has(t)) : [];
  if (!attemptId || clean.length === 0) {
    return NextResponse.json(
      { error: "attemptId and at least one valid tag required." },
      { status: 400 },
    );
  }

  const owned = await pool.query(
    "select 1 from attempts where id = $1 and user_id = $2",
    [attemptId, user.id],
  );
  if (owned.rowCount === 0) {
    return NextResponse.json({ error: "Attempt not found." }, { status: 404 });
  }

  for (const tag of clean) {
    await pool.query(
      `insert into mistakes (attempt_id, tag, note) values ($1, $2, $3)`,
      [attemptId, tag, typeof note === "string" && note.trim() ? note.trim() : null],
    );
  }
  return NextResponse.json({ ok: true, count: clean.length });
}
