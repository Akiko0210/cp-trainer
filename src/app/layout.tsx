import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import GuildChampions from "@/components/GuildChampions";
import GuildLive from "@/components/GuildLive";
import Nav from "@/components/Nav";
import {
  getChampions,
  getMyGuild,
  getMyStanding,
  type CategoryChampions,
  type Guild,
  type MyStanding,
} from "@/lib/guild-queries";
import { getCurrentUser, getStreak, type Streak } from "@/lib/queries";

const inter = Inter({ subsets: ["latin"], variable: "--font-body" });
const space = Space_Grotesk({ subsets: ["latin"], variable: "--font-space" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono" });

export const metadata: Metadata = {
  title: "CP Trainer",
  description:
    "Personal competitive-programming trainer: topic mastery, mistake patterns, and what to solve next.",
};

// Applies the saved theme before first paint (system preference is default).
const themeInit = `(function(){try{var t=localStorage.theme;if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let user = null;
  let guild: Guild | null = null;
  let standing: MyStanding | null = null;
  let champions: CategoryChampions[] = [];
  let streak: Streak | null = null;
  try {
    user = await getCurrentUser();
    if (user) {
      // The streak is a header fixture now, so it loads with the shell rather
      // than with the dashboard.
      [guild, streak] = await Promise.all([
        getMyGuild(user.id),
        getStreak(user.id),
      ]);
      if (guild) {
        // Loaded in the layout rather than per page: the guild follows you
        // around the app (the header chip, the crown on every category card),
        // so it has to be right on first paint everywhere, not only on /guild.
        [standing, champions] = await Promise.all([
          getMyStanding(guild.id, user.id),
          getChampions(guild.id, user.id),
        ]);
      }
    }
  } catch {
    // DB unreachable — pages render their own error states.
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body
        className={`${inter.variable} ${space.variable} ${mono.variable} min-h-screen antialiased`}
      >
        {/* One live stream and one champions store for the whole app: every
            guild surface reads from these instead of opening its own. */}
        <GuildLive enabled={!!guild}>
          <GuildChampions initial={champions}>
            <Nav
              handle={user?.cf_handle ?? null}
              rating={user?.cf_rating ?? null}
              rank={user?.cf_rank ?? null}
              guild={
                guild
                  ? {
                      slug: guild.slug,
                      name: guild.name,
                      member_count: guild.member_count,
                    }
                  : null
              }
              standing={standing}
              streak={streak}
            />
            <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
              {children}
            </main>
          </GuildChampions>
        </GuildLive>
      </body>
    </html>
  );
}
