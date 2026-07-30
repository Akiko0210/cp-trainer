import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl, oauthConfigured } from "@/lib/auth";

// Kick off GitHub OAuth. The `state` value is stored in a short-lived cookie
// and checked in the callback — that's the CSRF guard.
export async function GET(req: Request) {
  if (!oauthConfigured()) {
    return NextResponse.redirect(new URL("/signin?error=unconfigured", req.url));
  }
  const state = randomBytes(16).toString("base64url");
  const jar = await cookies();
  jar.set("cpt_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  const origin = new URL(req.url).origin;
  return NextResponse.redirect(authorizeUrl(state, origin));
}
