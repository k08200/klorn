"use client";

import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { useMediaQuery } from "../lib/use-media-query";
import { ACCOUNT_ROUTES, AccountSheet, userInitials } from "./bottom-tabs";
import NotificationBell from "./notification-bell";

// Below the rail step (globals.css, --breakpoint-rail): the phone shell.
const PHONE_QUERY = "(width < 37.5rem)";

/**
 * The phone header's right side (below 600px): the notification bell with
 * its unread count and the account avatar, each a 44px target. The bell is
 * the same notification center the rail and the sidebar open; it mounts only
 * while the phone shell shows, so a wider window does not run a third copy of
 * its socket and polling next to the rail's and the sidebar's. The avatar
 * opens the account sheet the bottom tab bar used to own.
 */
export default function PhoneHeaderActions() {
  const pathname = usePathname();
  const { t } = useT();
  const { user } = useAuth();
  const phone = useMediaQuery(PHONE_QUERY);
  const [accountOpen, setAccountOpen] = useState(false);
  const closeAccount = useCallback(() => setAccountOpen(false), []);
  const initials = userInitials(user);
  const accountActive =
    accountOpen || ACCOUNT_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

  return (
    <div className="ml-auto flex items-center gap-1">
      {user && phone && <NotificationBell userId={user.id} touch />}
      <button
        type="button"
        onClick={() => setAccountOpen(true)}
        aria-label={t("bottomTabs.account")}
        aria-haspopup="dialog"
        aria-expanded={accountOpen}
        className="focus-ring flex size-11 items-center justify-center rounded-full"
      >
        <span
          aria-hidden="true"
          className={`flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-solid-hover text-role-caption font-bold text-accent-solid-ink ring-2 transition ${
            accountActive ? "ring-accent" : "ring-transparent"
          }`}
        >
          {initials || "?"}
        </span>
      </button>
      {accountOpen && <AccountSheet onClose={closeAccount} initials={initials} />}
    </div>
  );
}
