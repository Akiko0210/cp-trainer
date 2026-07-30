import { assertProductionEnv } from "@/lib/env";

/*
  Runs once per server process, before the first request is served.

  The point is to fail at boot rather than in front of a club member: a
  production deploy missing GITHUB_CLIENT_SECRET would otherwise start
  cleanly, render the dashboard, and only break when somebody tried to sign in.
*/
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    assertProductionEnv();
  }
}
