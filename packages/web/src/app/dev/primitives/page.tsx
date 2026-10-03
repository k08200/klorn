import { notFound } from "next/navigation";
import PrimitivesPreview from "./primitives-preview";

/**
 * Dev-only gallery of the P2 UI primitives, for visual and keyboard checks in
 * both themes. NODE_ENV is "production" in every deployed build, so there this
 * route renders the not-found page and never the gallery. (The HTTP status is
 * 200, not 404: the root loading.tsx starts streaming before notFound() runs —
 * same as any notFound() below it. Robots are told not to index it.)
 */
export const metadata = { robots: { index: false, follow: false } };

export default function PrimitivesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PrimitivesPreview />;
}
