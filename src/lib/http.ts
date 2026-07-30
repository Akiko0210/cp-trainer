/*
  Where this request thinks it came from.

  Behind any TLS-terminating proxy — a platform router, Caddy, nginx — the app
  itself is spoken to over plain HTTP, so `new URL(req.url).origin` comes back
  as `http://…`. Handing that to GitHub as an OAuth redirect_uri gets the
  sign-in rejected outright, which is the classic "worked on localhost, broken
  the moment it was deployed" bug. The proxy tells us the truth in
  x-forwarded-proto / x-forwarded-host; we prefer those.

  PUBLIC_ORIGIN wins over both, for the case where the app sits behind
  something that doesn't set the headers at all.
*/
export function originOf(req: Request): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  // A comma-separated chain means several proxies; the first entry is the one
  // the browser actually spoke to.
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ??
    url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
