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
  title: "Jigeum - 지금 중요한 일",
  description: "Jigeum은 메일, 캘린더, 할 일, 기억을 지금 봐야 할 결정 카드로 정리합니다.",
  manifest: "/manifest.json",
  openGraph: {
    title: "Jigeum - 지금 중요한 일",
    description: "업무 신호, 결정 맥락, 승인, 기억을 조용히 정리하는 작업 레이어입니다.",
    siteName: "Jigeum",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Jigeum - 지금 중요한 일",
    description: "흩어진 업무 신호를 맥락, 승인, 기억이 있는 결정으로 바꿉니다.",
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
