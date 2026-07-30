import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSession, exchangeCode, upsertGithubUser } from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = await cookies();
  const expected = jar.get("cpt_oauth_state")?.value;
  jar.delete("cpt_oauth_state");

  // Reject anything that didn't originate from our own signin route.
  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(new URL("/signin?error=state", url.origin));
  }

  try {
    const profile = await exchangeCode(code, url.origin);
    const userId = await upsertGithubUser(profile);
    await createSession(userId, req.headers.get("user-agent") ?? undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sign-in failed.";
    return NextResponse.redirect(
      new URL(`/signin?error=${encodeURIComponent(message)}`, url.origin),
    );
  }

  return NextResponse.redirect(new URL("/", url.origin));
}
