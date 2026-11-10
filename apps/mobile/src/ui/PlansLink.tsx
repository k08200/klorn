import type { MouseEvent } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { useLinkProps } from "../router/Router";

/**
 * The way to Pro on mobile: the in-app Plans screen, where the store sells the
 * subscription. Never a web checkout (App Store 3.1.1), so every "needs Pro"
 * note ends with this link instead of a URL.
 *
 * `onNavigate` runs on the tap, before the route changes: a sheet that holds
 * the link closes itself with it (the router does nothing when Plans is
 * already the current route, so the sheet would otherwise stay).
 */
export function PlansLink({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const plans = useLinkProps({ name: "settings", section: "plans" });
  return (
    <a
      href={plans.href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onNavigate?.();
        plans.onClick(event);
      }}
    >
      {t("calendar.draft.seePlans")}
    </a>
  );
}
