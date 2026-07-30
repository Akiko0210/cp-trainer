import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getGroup, rotateInviteCode } from "@/lib/group-queries";

// Rotate a leaked code. Owners and admins only — enforced in the query.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { slug } = await params;
  const group = await getGroup(slug, user.id);
  if (!group) return NextResponse.json({ error: "No such group." }, { status: 404 });

  const code = await rotateInviteCode(group.id, user.id);
  if (!code) {
    return NextResponse.json(
      { error: "Only owners and admins can rotate the code." },
      { status: 403 },
    );
  }
  return NextResponse.json({ invite_code: code });
}
