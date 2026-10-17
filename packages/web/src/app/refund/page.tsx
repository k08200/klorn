import type { Metadata } from "next";
import Link from "next/link";
import RefundPolicy from "../../components/refund-policy";

export const metadata: Metadata = {
  title: "Refund Policy - Klorn",
  description: "Klorn Pro cancellation and refund policy.",
};

const updatedAt = "October 17, 2026";

export default function RefundPage() {
  return (
    <main id="main" className="min-h-screen sky-bg text-ink">
      <nav className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-[#f5f0e8]">
            <img src="/brand/mark.svg?v=matte2" alt="" className="h-9 w-9" />
          </div>
          <span className="text-lg font-bold tracking-tight">Klorn</span>
        </Link>
        <div className="flex items-center gap-5 text-sm text-ink-mid">
          <Link href="/terms" className="transition hover:text-ink">
            Terms
          </Link>
          <Link href="/privacy" className="transition hover:text-ink">
            Privacy
          </Link>
          <Link href="/login" className="transition hover:text-ink">
            Log in
          </Link>
        </div>
      </nav>

      <article className="mx-auto max-w-4xl px-6 py-14">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-accent-deep">
          REFUND POLICY
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-ink md:text-5xl">
          Cancellation and Refunds
        </h1>
        <p className="mt-5 max-w-2xl text-sm leading-6 text-ink-mid">
          Last updated: {updatedAt}. This policy is also part of the{" "}
          <Link href="/terms#billing-cancellation-and-refunds" className="underline">
            Klorn Terms of Service
          </Link>
          .
        </p>

        <div className="mt-12 space-y-3 text-base leading-7 text-ink-mid">
          <RefundPolicy />
        </div>
      </article>
    </main>
  );
}
