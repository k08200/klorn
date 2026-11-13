// The static export's page for this route (pageExtensions in next.config.ts):
// one shell, prerendered under the placeholder id, that Cloudflare serves for
// every id (public/_redirects); the page reads the real id from the URL.
import { StaticRouteShell } from "../../../components/static-route-shell";
import { STATIC_SHELL_PARAM } from "../../../lib/route-param";
import CalendarEventPage from "./calendar-event-page";

export const dynamicParams = false;

export function generateStaticParams() {
  return [{ id: STATIC_SHELL_PARAM }];
}

export default function Page() {
  return (
    <StaticRouteShell>
      <CalendarEventPage />
    </StaticRouteShell>
  );
}
