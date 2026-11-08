/**
 * Plans: the current plan (GET /api/billing/status) and, natively, the store
 * purchase through RevenueCat (platform/iap.ts). There is never a web
 * checkout or an external purchase link in the app (App Store 3.1.1) — the
 * price, the purchase sheet and the subscription page are the store's own.
 * Without a RevenueCat key (or in a browser) the screen shows the plan only.
 *
 * Next to "Subscribe" the screen states what App Store 3.1.2 asks the purchase
 * flow to state: the subscription's title, its length and price per period
 * (from the store package), that it renews automatically unless cancelled 24 h
 * before the period ends, how to cancel (the store's settings), and links to
 * the Terms of Use and the Privacy Policy; Restore purchases sits beside it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useMe } from "../../api/queries";
import { hk, useBillingStatus } from "../../api/queries-hub";
import { useI18n } from "../../i18n/I18nProvider";
import { openExternal } from "../../platform/external";
import {
  currentOffer,
  iapAvailable,
  managementUrl,
  restoreNativePurchases,
  type StoreOffer,
  startNativePurchase,
  storePlatform,
} from "../../platform/iap";
import { Icon } from "../../ui/Icon";
import { ProblemState, SkeletonRows } from "../../ui/StateView";
import { notify } from "../../ui/StatusNote";
import { PRIVACY_URL, SettingsBack, TERMS_URL } from "./parts";
import { lengthText, planLabel, pricePerText } from "./plans-model";

const PRO_PLANS = new Set(["PRO", "TEAM", "BUSINESS", "ENTERPRISE"]);

const STORE_NAMES = { ios: "App Store", android: "Google Play" } as const;

/** Terms of Use · Privacy Policy, opened in the system browser. */
function LegalLinks() {
  const { t } = useI18n();
  const links = [
    { href: TERMS_URL, label: t("plans.terms") },
    { href: PRIVACY_URL, label: t("welcome.privacy") },
  ];
  return (
    <nav className="plan-legal" aria-label={t("plans.legal")}>
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(link.href);
          }}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

/** The store offer with the 3.1.2 disclosures: title, length, price per period. */
function OfferCard({ offer }: { offer: StoreOffer }) {
  const { t } = useI18n();
  const length = offer.length ? lengthText(offer.length) : null;
  const price = offer.length ? pricePerText(offer.length, offer.priceString) : null;
  return (
    <section className="plan-offer card" aria-labelledby="offer-h">
      <span className="plan-card__label">{t("plans.offer.label")}</span>
      <h2 id="offer-h" className="plan-offer__title">
        {offer.title}
      </h2>
      <dl className="plan-offer__facts">
        {length ? (
          <div>
            <dt>{t("plans.offer.length")}</dt>
            <dd>{t(length.key, length.values)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("plans.offer.price")}</dt>
          <dd>{price ? t(price.key, price.values) : offer.priceString}</dd>
        </div>
      </dl>
    </section>
  );
}

export function PlansScreen() {
  const { t, intlTag } = useI18n();
  const queryClient = useQueryClient();
  const me = useMe();
  const billing = useBillingStatus();
  const [offer, setOffer] = useState<StoreOffer | null>(null);
  const [manage, setManage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"buy" | "restore" | null>(null);
  const store = iapAvailable();
  const platform = storePlatform();
  const userId = me.data?.id;

  useEffect(() => {
    if (!store || !userId) return;
    void currentOffer(userId).then(setOffer);
    void managementUrl(userId).then(setManage);
  }, [store, userId]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: hk.billing }),
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
    ]);

  const buy = async () => {
    if (!userId) return;
    setBusy("buy");
    const outcome = await startNativePurchase(userId);
    setBusy(null);
    if (outcome === "purchased") {
      notify(t("plans.purchased"));
      await refresh();
    } else if (outcome === "error") notify(t("plans.purchaseFailed"), "error");
    else if (outcome === "unavailable") notify(t("plans.unavailable"), "info");
  };

  const restore = async () => {
    if (!userId) return;
    setBusy("restore");
    const restored = await restoreNativePurchases(userId);
    setBusy(null);
    notify(t(restored ? "plans.restored" : "plans.nothingToRestore"), restored ? "ok" : "info");
    if (restored) await refresh();
  };

  const data = billing.data;
  const pro = data ? PRO_PLANS.has(data.plan) : false;
  const date = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(intlTag, { year: "numeric", month: "long", day: "numeric" }).format(
          new Date(iso),
        )
      : "";

  return (
    <div className="settings">
      <SettingsBack to={{ name: "settings" }} label={t("settings.title")} />
      <h1 className="screen-title">{t("plans.title")}</h1>
      {billing.isError && !data ? (
        <ProblemState kind="error" onRetry={() => void billing.refetch()} />
      ) : !data ? (
        <SkeletonRows rows={2} />
      ) : (
        <section className="plan-card card" aria-labelledby="plan-h">
          <span className="plan-card__label">{t("plans.current")}</span>
          <h2 id="plan-h" className="plan-card__name">
            {planLabel(t, data.planName)}
          </h2>
          {data.cancelAt ? (
            <p className="plan-card__line">{t("plans.endsOn", { date: date(data.cancelAt) })}</p>
          ) : data.renewsAt ? (
            <p className="plan-card__line">{t("plans.renewsOn", { date: date(data.renewsAt) })}</p>
          ) : null}
        </section>
      )}

      <section className="plan-benefits card" aria-labelledby="pro-h">
        <h2 id="pro-h" className="plan-benefits__title">
          {t("plans.pro.title")}
        </h2>
        <ul>
          {(["send", "accounts", "calendar", "assistant", "files"] as const).map((k) => (
            <li key={k}>
              <Icon name="check" size={18} strokeWidth={2.2} />
              {t(`plans.pro.${k}`)}
            </li>
          ))}
        </ul>
      </section>

      {store && offer ? <OfferCard offer={offer} /> : null}

      {store ? (
        <div className="plan-actions">
          {!pro ? (
            <button
              type="button"
              className="button button--primary"
              disabled={busy !== null}
              onClick={() => void buy()}
            >
              {busy === "buy"
                ? t("plans.working")
                : offer
                  ? t("plans.subscribePrice", {
                      price: offer.length
                        ? t(
                            pricePerText(offer.length, offer.priceString).key,
                            pricePerText(offer.length, offer.priceString).values,
                          )
                        : offer.priceString,
                    })
                  : t("plans.subscribe")}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--quiet"
            disabled={busy !== null}
            onClick={() => void restore()}
          >
            {busy === "restore" ? t("plans.working") : t("plans.restore")}
          </button>
          {manage ? (
            <button
              type="button"
              className="button button--plain"
              onClick={() => void openExternal(manage)}
            >
              {t("plans.manage")}
            </button>
          ) : null}
          {platform ? (
            <div className="plan-terms">
              <p>{t("plans.autoRenew", { store: STORE_NAMES[platform] })}</p>
              <p>{t(platform === "ios" ? "plans.cancel.ios" : "plans.cancel.android")}</p>
            </div>
          ) : null}
          <LegalLinks />
        </div>
      ) : (
        <>
          <p className="set-group__foot">{t("plans.notInApp")}</p>
          <LegalLinks />
        </>
      )}
    </div>
  );
}
