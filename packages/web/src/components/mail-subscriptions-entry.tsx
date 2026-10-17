"use client";

/**
 * Entry point to Mail → Subscriptions. Renders nothing until the list has
 * loaded, so while BULK_UNSUBSCRIBE_ENABLED is off (the list answers 404) there
 * is no trace of the page anywhere in Mail.
 */

import Link from "next/link";
import { useT } from "../lib/i18n";
import { useMailSubscriptionsAvailable } from "../lib/use-mail-subscriptions";

export default function MailSubscriptionsEntry({ className = "" }: { className?: string }) {
  const { t } = useT();
  if (!useMailSubscriptionsAvailable()) return null;
  return (
    <Link
      href="/email/subscriptions"
      className={`focus-ring inline-flex min-h-11 items-center rounded-control border border-line bg-surface-panel px-3 text-label text-ink-mid transition-colors duration-120 hover:bg-surface-hover hover:text-ink ${className}`}
    >
      {t("mailSubscriptions.entry")}
    </Link>
  );
}
