// The Next server build's page for this route (pageExtensions in next.config.ts):
// rendered per request, the id taken from the router. The static export uses
// page.static.tsx instead.
import EmailDetailPage from "./email-detail-page";

export default function Page() {
  return <EmailDetailPage />;
}
