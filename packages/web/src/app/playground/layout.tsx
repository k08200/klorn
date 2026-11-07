import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TIER_COUNT } from "@/lib/tiers";

const TITLE = "Klorn Playground — see how Klorn sorts one email";
const DESCRIPTION = `Try Klorn's ${TIER_COUNT}-lane email firewall without signing in. Paste an email, bring your own model key, and see which lane Klorn's real judge puts it in — and the four scores that decided it.`;

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
