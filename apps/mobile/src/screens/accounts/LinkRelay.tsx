/**
 * Finishes an account link when the system browser hands back
 * `ai.klorn.app://link-complete?h=…` (platform/link-relay.ts): POST
 * /api/auth/link/complete with this session, then say what happened and
 * refresh what changed. Mounted once while signed in; renders nothing.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { isApiError } from "../../api/client";
import { getServices } from "../../app/services";
import type { MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { installLinkRelay, type LinkResult, linkOutcome } from "../../platform/link-relay";
import { notify } from "../../ui/StatusNote";

const RESULT_KEYS: Record<LinkResult, MessageKey> = {
  success: "accounts.link.success",
  failed: "accounts.link.failed",
  unverified: "accounts.link.unverified",
  pro: "accounts.add.needsPro",
  limit: "accounts.link.limit",
  self: "accounts.link.self",
  "scope-missing": "accounts.link.scope",
};

export function LinkRelay() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      installLinkRelay((handle) => {
        void (async () => {
          try {
            const { next } = await getServices().ep.accounts.linkComplete(handle);
            const outcome = linkOutcome(next);
            notify(t(RESULT_KEYS[outcome.result]), outcome.result === "success" ? "ok" : "error");
          } catch (err) {
            notify(
              t(
                isApiError(err) && err.status === 404
                  ? "accounts.link.expired"
                  : "accounts.link.failed",
              ),
              "error",
            );
          } finally {
            await Promise.all(
              [["mail"], ["accounts"], ["calendar"], ["files"], ["auth", "me"]].map((queryKey) =>
                queryClient.invalidateQueries({ queryKey }),
              ),
            );
          }
        })();
      }),
    [queryClient, t],
  );
  return null;
}
