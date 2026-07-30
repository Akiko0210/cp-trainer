import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { createGroup, getMyGroups, joinByCode } from "@/lib/group-queries";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json(await getMyGroups(user.id));
}

// POST { name, description }  -> create
// POST { code }               -> join
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  if (typeof body.code === "string" && body.code.trim()) {
    const group = await joinByCode(user.id, body.code);
    if (!group) {
      return NextResponse.json(
        { error: "No group has that code. Check it with whoever invited you." },
        { status: 404 },
      );
    }
    return NextResponse.json(group);
  }

  if (typeof body.name === "string" && body.name.trim().length >= 2) {
    return NextResponse.json(
      await createGroup(user.id, body.name, body.description),
    );
  }

  return NextResponse.json(
    { error: "Give the group a name, or enter an invite code." },
    { status: 400 },
  );
}
