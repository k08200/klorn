import type { Metadata, Viewport } from "next";
import AppShell from "../components/app-shell";
import CommandPalette from "../components/command-palette";
import KeyboardShortcuts from "../components/keyboard-shortcuts";
import Providers from "../components/providers";
import PushOnboardingBanner from "../components/push-onboarding-banner";
import PushRegister from "../components/push-register";
import PwaPrompts from "../components/pwa-prompts";
import ServiceWorkerRegister from "../components/sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "Klorn — The clear signal worth acting on",
  description:
    "Klorn filters mail, calendar, and AI signals into one clear decision queue — with approval before any action.",
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
      "The approval layer for AI agents. Mail, calendar, and signals filtered into one clear decision queue.",
    images: ["/brand/og-image.png?v=k2"],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Klorn",
  },
};

export const viewport: Viewport = {
  themeColor: "#030712",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-surface-app text-stone-100 antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-4 focus-visible:top-4 focus-visible:z-[200] focus-visible:rounded-md focus-visible:bg-surface-elevated focus-visible:px-4 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:text-accent focus-visible:ring-2 focus-visible:ring-accent"
        >
          Skip to main content
        </a>
        <Providers>
          <KeyboardShortcuts />
          <CommandPalette />
          <AppShell>{children}</AppShell>
          <ServiceWorkerRegister />
          <PushRegister />
          <PushOnboardingBanner />
          <PwaPrompts />
        </Providers>
      </body>
    </html>
  );
}
