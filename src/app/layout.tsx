import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";
import { getCurrentUser } from "@/lib/queries";

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
  try {
    user = await getCurrentUser();
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
        <Nav
          handle={user?.cf_handle ?? null}
          rating={user?.cf_rating ?? null}
          rank={user?.cf_rank ?? null}
        />
        <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
          {children}
        </main>
      </body>
    </html>
  );
}
