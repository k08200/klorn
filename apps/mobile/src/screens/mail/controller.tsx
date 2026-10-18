/**
 * Mail's actions, shared by the list, the reader and the sheets:
 *
 *  - Done (swipe right / 처리 완료): the row leaves at once, a 5 s undo opens,
 *    and only when it closes does POST /api/inbox/firewall/email/:emailId/dismiss
 *    go out (the server has no un-dismiss — the undo is client-side, before
 *    sending). Keyed by the email id, so any mail in any account works; the
 *    list asks `hideHandled=1`, so the Done shows on every device.
 *  - Lane move (swipe left → sheet / 레인 옮기기): POST
 *    /api/inbox/firewall/email/:emailId at once; its undo token reverses it
 *    through POST /:id/undo. While KEYBOARD_TRIAGE keeps that route dark, the
 *    older POST /:id (by attention item, irreversible) is used and no undo is
 *    offered. "Keep this sender here" → POST /api/email/:id/pin-tier.
 *  - Later (나중에): hidden until the chosen time, POST
 *    /api/inbox/firewall/email/:emailId/snooze after the same 5 s window.
 *  - While the by-email routes are dark (an older server's bare 404), Done and
 *    Later fall back to the attention item id from the firewall board.
 *
 * None of these touch the mailbox: a lane is a classification, Done and Later
 * are Klorn's lists only. The account of each mail is the server's to resolve
 * from the mail's own row (linked inbox included), never assumed primary.
 */
import type { EmailListItem, FirewallResponse, LiveTier } from "@klorn/contract";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { isApiError } from "../../api/client";
import { qk } from "../../api/queries";
import { getServices } from "../../app/services";
import { useI18n } from "../../i18n/I18nProvider";
import { hapticSuccess, hapticWarning } from "../../platform/haptics";
import { isDarkRoute, mailKeys, patchMailTier } from "./data";
import {
  DONE_HIDE_MS,
  hideMail,
  loadHidden,
  SETTLED_HIDE_MS,
  settleHidden,
  unhideMail,
} from "./hidden-store";
import { recordLaneMoves } from "./lane-history";
import { attentionByEmail, senderLabel } from "./model";
import { UndoQueue, type UndoSnapshot } from "./undo-queue";

export interface MailTarget {
  id: string;
  from: string;
  subject: string;
  tier: LiveTier | null;
}

export function targetOf(
  email: Pick<EmailListItem, "id" | "from" | "subject" | "tier">,
): MailTarget {
  return { id: email.id, from: email.from, subject: email.subject, tier: email.tier };
}

interface MailActions {
  done(targets: readonly MailTarget[]): void;
  moveLane(targets: readonly MailTarget[], tier: LiveTier, pin: boolean): Promise<boolean>;
  snooze(target: MailTarget, until: Date): void;
  undo(): void;
  dismissSnackbar(): void;
  snackbar: UndoSnapshot["current"];
  error: string | null;
  clearError(): void;
  showError(message: string): void;
  notice: string | null;
  showNotice(message: string): void;
}

const MailContext = createContext<MailActions | null>(null);

/** EmailMessage id → attention item id, learned from lane moves (their answers carry it). */
const learnedItemIds = new Map<string, string>();

export function MailProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { t, tn } = useI18n();
  const [queue] = useState(() => new UndoQueue());
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void loadHidden();
  }, []);

  // Leaving the app flushes what is waiting, so a swipe-then-close still lands.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") queue.flush();
    };
    const onPageHide = () => queue.flush();
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", onPageHide);
      queue.flush();
    };
  }, [queue]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const settled = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.firewall() });
    void qc.invalidateQueries({ queryKey: qk.laneCounts() });
    void qc.invalidateQueries({ queryKey: ["mail", "lane-counts"] });
  }, [qc]);

  /** The mail's OPEN attention item, from the firewall cache, else a fresh read. */
  const itemIdOf = useCallback(
    async (emailId: string): Promise<string | null> => {
      const learned = learnedItemIds.get(emailId);
      if (learned) return learned;
      const cached = attentionByEmail(qc.getQueryData<FirewallResponse>(qk.firewall("all")));
      const hit = cached.get(emailId);
      if (hit) return hit.itemId;
      const fresh = await qc.fetchQuery({
        queryKey: qk.firewall("all"),
        queryFn: ({ signal }) => getServices().ep.mail.firewall("all", { signal }),
        staleTime: 0,
      });
      return attentionByEmail(fresh).get(emailId)?.itemId ?? null;
    },
    [qc],
  );

  /**
   * Done or Later on the server, by email id. Resolves true when the server
   * changed the mail's attention item (so its own lists now hide it) and false
   * when there was nothing to clear — then only this device hides it.
   */
  const clearOnServer = useCallback(
    async (emailId: string, until: Date | null): Promise<boolean> => {
      const { ep } = getServices();
      try {
        const res = until
          ? await ep.triage.snoozeByEmail(emailId, until)
          : await ep.triage.doneByEmail(emailId);
        return !res.alreadyClear;
      } catch (err) {
        if (!isDarkRoute(err)) {
          // 404 not_found: the mail is gone or not this user's — nothing to clear.
          if (isApiError(err) && err.status === 404) return false;
          throw err;
        }
      }
      // An older server without the by-email routes (and without hideHandled):
      // the attention item from the firewall board, else the local hide alone.
      const itemId = await itemIdOf(emailId);
      if (!itemId) return false;
      try {
        if (until) await ep.triage.snooze(itemId, until);
        else await ep.triage.done(itemId);
      } catch (err) {
        if (isApiError(err) && err.status === 404) return false; // already resolved
        throw err;
      }
      return false;
    },
    [itemIdOf],
  );

  /** The server hides these now: shorten the optimistic hide and refetch the lists. */
  const confirmed = useCallback(
    (ids: readonly string[]) => {
      if (ids.length > 0) settleHidden(ids, Date.now() + SETTLED_HIDE_MS);
      void qc.invalidateQueries({ queryKey: mailKeys.feeds });
      settled();
    },
    [qc, settled],
  );

  const done = useCallback(
    (targets: readonly MailTarget[]) => {
      if (targets.length === 0) return;
      const ids = targets.map((m) => m.id);
      hideMail(ids, Date.now() + DONE_HIDE_MS);
      hapticSuccess();
      setError(null);
      queue.push({
        id: `done:${ids.join(",")}`,
        kind: "deferred",
        message: targets.length === 1 ? t("mail.done.one") : tn("mail.done.many", targets.length),
        commit: async () => {
          const cleared = await Promise.all(ids.map((emailId) => clearOnServer(emailId, null)));
          confirmed(ids.filter((_, i) => cleared[i]));
        },
        revert: () => unhideMail(ids),
        onCommitError: (err) => {
          hapticWarning();
          setError(
            isApiError(err) && err.isOffline ? t("mail.error.offlineAction") : t("mail.error.done"),
          );
        },
      });
    },
    [queue, t, tn, clearOnServer, confirmed],
  );

  const moveLane = useCallback(
    async (targets: readonly MailTarget[], tier: LiveTier, pin: boolean): Promise<boolean> => {
      const { ep } = getServices();
      setError(null);
      const moving = targets.filter((m) => m.tier !== tier);
      for (const m of moving) patchMailTier(qc, m.id, tier);
      const handles: Array<{ itemId: string; undoToken: string | null; target: MailTarget }> = [];
      let reversible = true;
      try {
        for (const m of moving) {
          try {
            const res = await ep.triage.moveLane(m.id, tier);
            learnedItemIds.set(m.id, res.itemId);
            handles.push({ itemId: res.itemId, undoToken: res.undoToken ?? null, target: m });
            if (!res.undoToken) reversible = false;
          } catch (err) {
            if (!isDarkRoute(err)) throw err;
            // KEYBOARD_TRIAGE off: the older override by attention item, no undo.
            const itemId = await itemIdOf(m.id);
            if (!itemId) throw err;
            await ep.triage.moveLaneByItem(itemId, tier);
            reversible = false;
          }
        }
        if (pin) {
          // One pin per sender: the server keys the rule on the sender address.
          const bySender = new Map<string, MailTarget>();
          for (const m of targets) bySender.set(senderLabel(m.from).toLowerCase(), m);
          await Promise.all([...bySender.values()].map((m) => ep.triage.pinSender(m.id, tier)));
        }
      } catch (err) {
        for (const m of moving) patchMailTier(qc, m.id, m.tier);
        // Put back what did move, best-effort, so nothing is left half done.
        await Promise.allSettled(
          handles
            .filter((h) => h.undoToken)
            .map((h) => ep.triage.undoMove(h.itemId, h.undoToken ?? "")),
        );
        hapticWarning();
        setError(
          isApiError(err) && err.isOffline
            ? t("mail.error.offlineAction")
            : isApiError(err) && err.status === 404
              ? t("lane.error.notClassified")
              : isApiError(err) && err.status === 429
                ? t("lane.error.rateLimited")
                : t("lane.error.moveFailed"),
        );
        void qc.invalidateQueries({ queryKey: mailKeys.feeds });
        return false;
      }
      hapticSuccess();
      // The second move of the same sender opens the sheet with the pin on.
      if (moving.length > 0)
        void recordLaneMoves(
          moving.map((m) => m.from),
          tier,
        );
      const message =
        moving.length === 0
          ? t("lane.pinned", { lane: tier })
          : moving.length === 1
            ? t("lane.moved", { lane: tier })
            : tn("lane.movedMany", moving.length, { lane: tier });
      if (reversible && handles.length > 0) {
        queue.push({
          id: `lane:${moving.map((m) => m.id).join(",")}:${Date.now()}`,
          kind: "applied",
          message,
          revert: async () => {
            for (const h of handles) patchMailTier(qc, h.target.id, h.target.tier);
            const results = await Promise.allSettled(
              handles.map((h) => ep.triage.undoMove(h.itemId, h.undoToken ?? "")),
            );
            if (results.some((r) => r.status === "rejected")) {
              const first = results.find((r) => r.status === "rejected") as
                | PromiseRejectedResult
                | undefined;
              const code =
                first && isApiError(first.reason) && first.reason.status === 409
                  ? "lane.error.undoExpired"
                  : "lane.error.undoFailed";
              setError(t(code));
            }
            void qc.invalidateQueries({ queryKey: mailKeys.feeds });
            settled();
          },
        });
      } else {
        setNotice(message);
      }
      settled();
      return true;
    },
    [qc, queue, t, tn, itemIdOf, settled],
  );

  const snooze = useCallback(
    (target: MailTarget, until: Date) => {
      hideMail([target.id], until.getTime());
      hapticSuccess();
      setError(null);
      queue.push({
        id: `later:${target.id}`,
        kind: "deferred",
        message: t("mail.later.set"),
        commit: async () => {
          const cleared = await clearOnServer(target.id, until);
          confirmed(cleared ? [target.id] : []);
        },
        revert: () => unhideMail([target.id]),
        onCommitError: () => setError(t("mail.error.later")),
      });
    },
    [queue, t, clearOnServer, confirmed],
  );

  const value = useMemo<MailActions>(
    () => ({
      done,
      moveLane,
      snooze,
      undo: () => void queue.undo(),
      dismissSnackbar: () => queue.dismissCurrent(),
      snackbar: snapshot.current,
      error,
      clearError: () => setError(null),
      showError: setError,
      notice,
      showNotice: setNotice,
    }),
    [done, moveLane, snooze, queue, snapshot, error, notice],
  );
  return <MailContext.Provider value={value}>{children}</MailContext.Provider>;
}

export function useMail(): MailActions {
  const value = useContext(MailContext);
  if (!value) throw new Error("useMail outside MailProvider");
  return value;
}
