"use client";

/**
 * Google Drive on /files (step D5c of docs/providers/unified-platform-plan.md):
 * "Connect Google Drive" (POST /api/drive/google/link, then Google's consent for
 * drive.file only), the linked accounts with a disconnect, and, in a web built
 * with NEXT_PUBLIC_GOOGLE_DRIVE_PICKER=on, "Add from Google Drive": the Google
 * Picker (lib/google-picker.ts, whose script loads on the click), whose picked
 * ids go to POST /api/drive/google/accounts/:id/picked. Klorn reads those files'
 * metadata from Google and never changes them (V4).
 *
 * Dark like the routes: while GET /api/drive/google/accounts answers 404
 * (DRIVE_ENABLED or GOOGLE_DRIVE_ENABLED off on the server) this renders
 * nothing. Must render inside a <Suspense> (useSearchParams), as FilesView does.
 */

import type {
  GoogleDriveAccountsResponse,
  GoogleDriveAccountWire,
  GoogleDriveLinkOutcome,
  GoogleDrivePickedResponse,
  GoogleDrivePickerSessionResponse,
} from "@klorn/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { useConfirm } from "../../components/confirm-dialog";
import { isEntitlementRefusal } from "../../components/mail-account-pro-gate";
import { useToast } from "../../components/toast";
import Button from "../../components/ui/button";
import { apiFetch, startLinkGoogleDrive } from "../../lib/api";
import { FILES_HOME } from "../../lib/home";
import { useT } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

const ACCOUNTS_PATH = "/api/drive/google/accounts";

/**
 * The Picker module, only in a build with the switch on. The condition is the
 * literal env read so the bundler drops the import (and its chunk) when the
 * switch is off: next.config.ts always defines the variable, "" when off.
 */
const loadGooglePicker =
  process.env.NEXT_PUBLIC_GOOGLE_DRIVE_PICKER === "on"
    ? () => import("../../lib/google-picker")
    : null;

const LINK_OUTCOMES: Readonly<Record<GoogleDriveLinkOutcome, string>> = {
  success: "files.google.link.success",
  failed: "files.google.link.failed",
  unverified: "files.google.link.unverified",
  "scope-missing": "files.google.link.scopeMissing",
  limit: "files.google.link.limit",
};

const isApiStatus = (err: unknown, status: number) =>
  err instanceof Error && err.message.startsWith(`API ${status}`);

const accountPath = (id: string, step: "picker-session" | "picked") =>
  `${ACCOUNTS_PATH}/${encodeURIComponent(id)}/${step}`;

/**
 * The linked accounts; null while the feature is dark. Any other failure throws,
 * so a list already shown stays (react-query keeps the last data) and a first
 * load that fails shows nothing.
 */
function useGoogleDriveAccounts() {
  return useQuery({
    queryKey: queryKeys.drive.googleAccounts(),
    queryFn: async (): Promise<GoogleDriveAccountWire[] | null> => {
      try {
        return (await apiFetch<GoogleDriveAccountsResponse>(ACCOUNTS_PATH)).accounts;
      } catch (err) {
        if (isApiStatus(err, 404)) return null;
        captureClientError(err, { scope: "files.google.accounts" });
        throw err;
      }
    },
    retry: false,
  });
}

/** `/files?drive=<outcome>` after a link: say it once, then drop it from the URL. */
function useLinkOutcome() {
  const { t } = useT();
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const outcome = useSearchParams().get("drive");
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (outcome === null) {
      // Gone from the URL: the next outcome is news, even the same one again.
      told.current = null;
      return;
    }
    if (told.current === outcome || !Object.hasOwn(LINK_OUTCOMES, outcome)) return;
    told.current = outcome;
    const key = LINK_OUTCOMES[outcome as GoogleDriveLinkOutcome];
    toast(t(key), outcome === "success" ? "success" : "error");
    if (outcome === "success") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.drive.googleAccounts() });
    }
    router.replace(FILES_HOME, { scroll: false });
  }, [outcome, t, toast, router, queryClient]);
}

/** Picker session, the Picker, then the picked ids: null when the person closed it. */
async function pickAndIndex(
  accountId: string,
  locale: string,
): Promise<GoogleDrivePickedResponse | null> {
  if (loadGooglePicker === null) return null;
  const session = await apiFetch<GoogleDrivePickerSessionResponse>(
    accountPath(accountId, "picker-session"),
    { method: "POST" },
  );
  const { pickGoogleDriveFiles } = await loadGooglePicker();
  const ids = await pickGoogleDriveFiles(session, locale);
  if (ids === null || ids.length === 0) return null;
  return await apiFetch<GoogleDrivePickedResponse>(accountPath(accountId, "picked"), {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

function pickErrorKey(err: unknown): string {
  if (isEntitlementRefusal(err instanceof Error ? err.message : "")) {
    return "mailAccount.proGate.title";
  }
  if (isApiStatus(err, 409)) return "files.google.pick.reconnect";
  if (isApiStatus(err, 503)) return "files.google.pick.notConfigured";
  return "files.google.pick.error";
}

export function GoogleDriveConnect() {
  const { t, locale } = useT();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const queryClient = useQueryClient();
  const accounts = useGoogleDriveAccounts();
  useLinkOutcome();

  // A mutation, so a double click cannot start two consents.
  const connect = useMutation({
    mutationFn: () => startLinkGoogleDrive(),
    onError: (err) => {
      if (isEntitlementRefusal(err instanceof Error ? err.message : "")) {
        toast(t("mailAccount.proGate.title"), "error");
        return;
      }
      captureClientError(err, { scope: "files.google.connect" });
      toast(t("files.google.connect.error"), "error");
    },
  });

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`${ACCOUNTS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.drive.all });
      toast(t("files.google.disconnect.done"), "success");
    },
    onError: (err) => {
      captureClientError(err, { scope: "files.google.disconnect" });
      toast(t("files.google.disconnect.error"), "error");
    },
  });

  const add = useMutation({
    mutationFn: (id: string) => pickAndIndex(id, locale),
    onSuccess: (result) => {
      if (result === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.drive.all });
      const capped = result.refused.filter((r) => r.code === "cap").length;
      const skipped = result.refused.length - capped;
      if (result.added > 0) {
        toast(t("files.google.pick.added", { count: String(result.added) }), "success");
      }
      if (skipped > 0) toast(t("files.google.pick.skipped", { count: String(skipped) }), "info");
      if (capped > 0) toast(t("files.google.pick.cap", { count: String(capped) }), "info");
    },
    onError: (err) => {
      captureClientError(err, { scope: "files.google.pick" });
      toast(t(pickErrorKey(err)), "error");
    },
  });

  const confirmDisconnect = async (account: GoogleDriveAccountWire) => {
    const ok = await confirm({
      title: t("files.google.disconnect.title"),
      message: t("files.google.disconnect.message", { email: account.email }),
      confirmLabel: t("files.google.disconnect.confirm"),
      danger: true,
    });
    if (ok) disconnect.mutate(account.id);
  };

  const list = accounts.data;
  if (list === null || list === undefined) return null;

  return (
    <section
      aria-labelledby="files-google-heading"
      className="flex flex-col gap-3 rounded-card border border-line bg-surface-panel p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="files-google-heading" className="text-body font-semibold text-ink">
            {t("files.google.title")}
          </h2>
          <p className="text-body text-ink-muted">{t("files.google.body")}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => connect.mutate()}
          loading={connect.isPending}
          disabled={connect.isPending}
        >
          {t("files.google.connect")}
        </Button>
      </div>
      {list.length > 0 && (
        <ul className="flex flex-col divide-y divide-line-soft">
          {list.map((account) => (
            <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-body text-ink">{account.email}</span>
                {account.needsReconnect && (
                  <span className="text-body text-ink-muted">
                    {t("files.google.needsReconnect")}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {account.needsReconnect ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => connect.mutate()}
                    disabled={connect.isPending}
                    aria-label={t("files.google.reconnect.label", { email: account.email })}
                  >
                    {t("files.google.reconnect")}
                  </Button>
                ) : (
                  loadGooglePicker !== null && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => add.mutate(account.id)}
                      loading={add.isPending && add.variables === account.id}
                      disabled={add.isPending}
                      aria-label={t("files.google.add.label", { email: account.email })}
                    >
                      {t("files.google.add")}
                    </Button>
                  )
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void confirmDisconnect(account)}
                  disabled={disconnect.isPending}
                  aria-label={t("files.google.disconnect.label", { email: account.email })}
                >
                  {t("files.google.disconnect")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
