import type { NextConfig } from "next";

/*
  Production posture.

  `standalone` output makes a Docker image carry only the files the server
  actually needs rather than the whole node_modules tree — roughly 150MB
  instead of 1GB, which matters on a free tier's disk quota.

  The headers are the boring, load-bearing kind. This app renders other
  people's display names and handles on your screen, so it shouldn't be
  frameable, shouldn't sniff content types, and shouldn't leak the page you
  were on to Codeforces or Kattis when you click through to a problem.
*/
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          ...(process.env.NODE_ENV === "production"
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=31536000; includeSubDomains",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
