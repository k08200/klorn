import type { Metadata } from "next";
import RootRedirect from "../components/root-redirect";
import Loading from "./loading";

// The marketing landing lives at https://klorn.ai (website/). This route only
// routes visitors — token holders to /inbox, everyone else off the app host —
// so the two hosts never serve duplicate landing pages.
export const metadata: Metadata = {
  robots: { index: false },
};

export default function RootPage() {
  return (
    <>
      <RootRedirect />
      <Loading />
      <noscript>
        <p className="px-6 py-4 text-center text-sm text-stone-400">
          JavaScript is required to open the app. Visit{" "}
          <a href="https://klorn.ai" className="underline">
            klorn.ai
          </a>{" "}
          to learn about Klorn.
        </p>
      </noscript>
    </>
  );
}
