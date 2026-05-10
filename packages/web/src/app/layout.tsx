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
  title: "EVE - Decision OS for Work",
  description:
    "EVE turns email, calendar, tasks, and memory into decision cards you can inspect, approve, and trust.",
  manifest: "/manifest.json",
  openGraph: {
    title: "EVE - Decision OS for Work",
    description:
      "A quiet operating layer for work signals, decision context, approvals, and memory.",
    siteName: "hireEVE",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "EVE - Decision OS for Work",
    description: "Turn scattered work signals into decisions with context, approval, and memory.",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "EVE",
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
      <body className="bg-[#10100d] text-stone-100 antialiased">
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
