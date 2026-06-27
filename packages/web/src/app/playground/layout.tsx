import type { Metadata } from "next";
import type { ReactNode } from "react";

const TITLE = "Klorn Playground — see what would interrupt you";
const DESCRIPTION =
  "Try Klorn's 4-tier email firewall without signing in. Paste an email, bring your own LLM key, and see whether Klorn would interrupt you for it.";

// Own OpenGraph/Twitter card so a shared /playground link previews as the demo
// (not the generic homepage it would inherit from the root layout). metadataBase
// + the og image come from the root layout; this just overrides the copy.
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/playground",
    type: "website",
    images: [{ url: "/brand/og-image.png?v=k2", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/brand/og-image.png?v=k2"],
  },
};

export default function PlaygroundLayout({ children }: { children: ReactNode }) {
  return children;
}
