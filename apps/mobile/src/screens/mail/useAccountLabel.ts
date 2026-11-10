import type { InboxOption } from "@klorn/contract";
import { useCallback } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { accountShortLabel } from "./model";

/** accountShortLabel with the words of the app language. */
export function useAccountLabel(inboxes: readonly InboxOption[]) {
  const { t } = useI18n();
  return useCallback(
    (inbox: InboxOption | null): string | null =>
      inbox
        ? accountShortLabel(inbox, inboxes, {
            work: t("mail.account.purpose.work"),
            personalGmail: t("mail.account.gmailPersonal"),
            naver: t("mail.account.naver"),
            primary: t("mail.account.primary"),
          })
        : null,
    [inboxes, t],
  );
}
