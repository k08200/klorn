import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Playground — Klorn",
  description:
    "Try Klorn's 4-tier email firewall without signing in. Paste an email, bring your own LLM key, and see whether Klorn would interrupt you for it.",
};

export default function PlaygroundLayout({ children }: { children: ReactNode }) {
  return children;
}
