import { notFound } from "next/navigation";
import PrimitivesPreview from "./primitives-preview";

/**
 * Dev-only gallery of the P2 UI primitives, for visual and keyboard checks in
 * both themes. The `.dev.tsx` extension is only a page extension outside
 * production (next.config.ts `pageExtensions`), so production builds have no
 * such route: a real 404 and no gallery chunk. The notFound() below is a
 * second guard in case that config ever changes.
 */
export const metadata = { robots: { index: false, follow: false } };

export default function PrimitivesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PrimitivesPreview />;
}
