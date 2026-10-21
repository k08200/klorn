import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
// Pretendard (OFL 1.1, public/licenses/pretendard-OFL.txt) for Hangul. The
// dynamic-subset build is ~90 small woff2 files, each behind a unicode-range,
// so a page downloads only the slices it renders; Latin stays on Geist, which
// sits ahead of it in --font-sans. Bundled by Next and served from
// /_next/static/media, so the strict CSP (font-src 'self') is unchanged.
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import AppShell from "../components/app-shell";
import CommandPalette from "../components/command-palette";
import GoogleReconnectBanner from "../components/google-reconnect-banner";
import KeyboardShortcuts from "../components/keyboard-shortcuts";
import Providers from "../components/providers";
import PushOnboardingBanner from "../components/push-onboarding-banner";
import PushRegister from "../components/push-register";
import PwaPrompts from "../components/pwa-prompts";
import SkipLink from "../components/skip-link";
import ServiceWorkerRegister from "../components/sw-register";
import "./globals.css";

// Self-hosted at build time by next/font (no runtime request to Google —
// the strict CSP stays intact). Korean text falls through to Pretendard
// (imported above): Windows has no Apple SD Gothic Neo, and its Malgun Gothic
// fallback sets Hangul noticeably heavier and wider than Geist.
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Klorn — The clear signal worth acting on",
  description:
    "All your mail and calendars in one calm place. Klorn sorts every message into one of five lanes, says why, and asks before it acts.",
  manifest: "/manifest.json",
  metadataBase: new URL("https://app.klorn.ai"),
  openGraph: {
    title: "Klorn — The clear signal worth acting on",
    description:
      "Other AI agents act. Klorn helps you decide what's worth acting on — with evidence and approval before anything leaves your hands.",
    siteName: "Klorn",
    url: "https://app.klorn.ai/",
    type: "website",
    images: [{ url: "/brand/og-image.png?v=k2", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Klorn — The clear signal worth acting on",
    description:
      "All your mail and calendars in one calm place — every message sorted, with the reason shown.",
    images: ["/brand/og-image.png?v=k2"],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Klorn",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Stamp .dark before first paint (stored override, else OS) — a
            post-hydration toggle would flash the wrong theme. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static, no interpolation
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=localStorage.getItem("klorn-theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()',
          }}
        />
      </head>
      <body className="font-sans bg-surface-app text-ink antialiased">
        <Providers>
          <SkipLink />
          <KeyboardShortcuts />
          <CommandPalette />
          <AppShell>{children}</AppShell>
          <ServiceWorkerRegister />
          <PushRegister />
          <GoogleReconnectBanner />
          <PushOnboardingBanner />
          <PwaPrompts />
        </Providers>
      </body>
    </html>
  );
}
