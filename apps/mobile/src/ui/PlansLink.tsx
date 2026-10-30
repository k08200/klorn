import { useI18n } from "../i18n/I18nProvider";
import { useLinkProps } from "../router/Router";

/**
 * The way to Pro on mobile: the in-app Plans screen, where the store sells the
 * subscription. Never a web checkout (App Store 3.1.1), so every "needs Pro"
 * note ends with this link instead of a URL.
 */
export function PlansLink() {
  const { t } = useI18n();
  const plans = useLinkProps({ name: "settings", section: "plans" });
  return <a {...plans}>{t("calendar.draft.seePlans")}</a>;
}
