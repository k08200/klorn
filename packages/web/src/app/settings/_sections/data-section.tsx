"use client";

import { useConfirm } from "../../../components/confirm-dialog";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import { API_BASE, authHeaders } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { PANEL, SECTION_TITLE } from "./shared";
import { PROFILE_KEY } from "./use-profile";

const PINNED_CHATS_KEY = "klorn-pinned-chats";

export function DataSection() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { t } = useT();

  const clearAllData = async () => {
    const ok = await confirm({
      title: t("settings.confirm.deleteWorkspace.title"),
      message: t("settings.confirm.deleteWorkspace.message"),
      confirmLabel: t("settings.confirm.deleteWorkspace.confirmLabel"),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/api/user/me/data`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      // Don't falsely tell the user their data was deleted (and wipe local
      // profile state) when the server-side delete actually failed.
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.deleteWorkspaceFailed"), "error");
        return;
      }
      localStorage.removeItem(PROFILE_KEY);
      localStorage.removeItem(PINNED_CHATS_KEY);
      toast(t("settings.toast.workspaceDeleted"), "info");
    } catch {
      toast(t("settings.toast.deleteWorkspaceFailed"), "error");
    }
  };

  const deleteAccount = async () => {
    const ok = await confirm({
      title: t("settings.confirm.deleteAccount.title"),
      message: t("settings.confirm.deleteAccount.message"),
      confirmLabel: t("settings.confirm.deleteAccount.confirmLabel"),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/account`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.deleteAccountFailed"), "error");
        return;
      }
      // Wipe local session and leave the app entirely.
      localStorage.clear();
      window.location.href = "/login?deleted=1";
    } catch {
      toast(t("settings.toast.deleteAccountFailed"), "error");
    }
  };

  const exportData = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/user/me/export`, { headers: authHeaders() });
      // Without this guard a 500's error JSON gets written into the downloaded
      // export file and the user is told the export succeeded.
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.exportFailed"), "error");
        return;
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `klorn-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast(t("settings.toast.exported"), "success");
    } catch {
      toast(t("settings.toast.exportFailed"), "error");
    }
  };

  return (
    <>
      {/* Data Management */}
      <section className="mb-8">
        <h2 className={SECTION_TITLE}>{t("settings.data")}</h2>
        <div className="space-y-3">
          <div className={`${PANEL} p-4 flex items-center justify-between gap-4`}>
            <div>
              <h3 className="font-medium">{t("settings.exportData")}</h3>
              <p className="text-sm text-ink-mid">{t("settings.exportWorkspace.desc")}</p>
            </div>
            <Button variant="secondary" onClick={exportData}>
              {t("settings.export")}
            </Button>
          </div>
        </div>
      </section>

      {/* Workspace Reset */}
      <section className="mb-8">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-state-danger-ink">
          {t("settings.dangerZone")}
        </h2>
        <div className="panel-elevated rounded-2xl border border-state-danger-line bg-surface-panel divide-y divide-state-danger-line">
          <div className="flex items-center justify-between gap-4 p-4">
            <div>
              <h3 className="font-medium">{t("settings.confirm.deleteWorkspace.title")}</h3>
              <p className="text-sm text-ink-mid">{t("settings.deleteWorkspace.desc")}</p>
            </div>
            <Button variant="danger" onClick={clearAllData}>
              {t("settings.deleteAll")}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-4 p-4">
            <div>
              <h3 className="font-medium">{t("settings.deleteBtn")}</h3>
              <p className="text-sm text-ink-mid mt-0.5">{t("settings.deleteAccount.desc")}</p>
            </div>
            <Button variant="danger" onClick={deleteAccount}>
              {t("settings.deleteBtn")}
            </Button>
          </div>
        </div>
      </section>

      {/* About */}
      <section>
        <h2 className={SECTION_TITLE}>{t("settings.about")}</h2>
        <div className={`${PANEL} p-4`}>
          <p className="text-sm text-ink-mid">
            <span className="text-accent-deep font-medium">Klorn</span> ·{" "}
            {t("settings.about.tagline")}
          </p>
          <p className="text-sm text-ink-dim mt-1">{t("settings.about.desc")}</p>
          <p className="text-xs text-ink-mid mt-3">{t("settings.about.version")}</p>
          {/* The support address lived only inside the privacy, terms and
                refund pages — all three on a noindex subdomain a signed-in user
                has no reason to open. A paying account needs a way to reach a
                human from the app itself. k0820086@gmail.com is the pinned
                contact: klorn.ai has no MX record, so a @klorn.ai address would
                bounce. */}
          <p className="text-xs text-ink-mid mt-2">
            {t("settings.about.support")}{" "}
            <a
              href="mailto:k0820086@gmail.com"
              className="text-accent-deep underline underline-offset-2 hover:text-accent"
            >
              k0820086@gmail.com
            </a>
          </p>
        </div>
      </section>
    </>
  );
}
