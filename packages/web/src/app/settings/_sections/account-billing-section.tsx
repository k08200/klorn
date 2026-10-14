"use client";

import Link from "next/link";
import { SubscriptionSection } from "../../../components/subscription-section";
import { useT } from "../../../lib/i18n";
import { ProfilePanel } from "./profile-panel";
import { SecurityPanel } from "./security-panel";

export function AccountBillingSection() {
  const { t } = useT();
  return (
    <>
      <ProfilePanel fields="identity" />
      <SecurityPanel />
      <SubscriptionSection />
      <Link
        href="/usage"
        className="focus-ring inline-flex min-h-11 items-center rounded-control text-label text-accent-deep hover:underline"
      >
        {t("billing.viewDetailedUsage")}
      </Link>
    </>
  );
}
