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
  title: "Jigeum - Decision Queue for Work",
  description: "Jigeum turns mail, calendar, tasks, and memory into clear decision cards.",
  manifest: "/manifest.json",
  openGraph: {
    title: "Jigeum - Decision Queue for Work",
    description: "A quiet work layer for signals, decision context, approvals, and memory.",
    siteName: "Jigeum",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Jigeum - Decision Queue for Work",
    description: "Turn scattered work signals into decisions with context, approval, and memory.",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Jigeum",
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
