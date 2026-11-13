"use client";

import { usePathname } from "next/navigation";
import { Fragment, type ReactNode, Suspense } from "react";

/**
 * Wraps a dynamic route's page in the static export (page.static.tsx).
 *
 * Every id is served by the same shell, so to the router `/email/a` and
 * `/email/b` are the same segment and it would keep the page mounted between
 * them — carrying one email's local state (a half-typed reply) into the next.
 * Keying by the pathname remounts it per id, as the Next server build does.
 * The Suspense boundary lets the prerender skip pages that read the query
 * string (useSearchParams); they render on the client, as they always have.
 */
export function StaticRouteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <Suspense fallback={null}>
      <Fragment key={pathname}>{children}</Fragment>
    </Suspense>
  );
}
