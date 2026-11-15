"use client";

// Settings → Data: "Export as markdown" (Klorn Vault). Shown only while the
// API's VAULT_EXPORT_ENABLED opens it to this user (/me user.vaultExport).
// Mail text is an explicit opt-in; the server streams the zip and keeps none.

import { useId, useState } from "react";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import { API_BASE, authHeaders } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { PANEL } from "./shared";
import {
  vaultExportFailure,
  vaultExportUrl,
  vaultExportVisible,
  vaultFileName,
} from "./vault-export";

export function VaultExportPanel() {
  const { user } = useAuth();
  const { t } = useT();
  const { toast } = useToast();
  const toggleId = useId();
  const [includeMailText, setIncludeMailText] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!vaultExportVisible(user)) return null;

  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch(vaultExportUrl(API_BASE, includeMailText), {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const failure = vaultExportFailure(res.status, body);
        toast(t(failure.key, failure.vars), "error");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = vaultFileName(new Date());
      a.click();
      URL.revokeObjectURL(url);
      toast(t("vaultExport.done"), "success");
    } catch {
      toast(t("vaultExport.error.failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${PANEL} p-4 space-y-3`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-medium">{t("vaultExport.title")}</h3>
          <p className="text-role-body text-ink-mid">{t("vaultExport.desc")}</p>
        </div>
        <Button variant="secondary" onClick={download} loading={busy}>
          {t("vaultExport.button")}
        </Button>
      </div>
      <label
        htmlFor={toggleId}
        className="flex min-h-11 items-start gap-3 cursor-pointer rounded-control px-2 py-2 hover:bg-surface-hover transition"
      >
        <input
          id={toggleId}
          type="checkbox"
          checked={includeMailText}
          disabled={busy}
          onChange={(e) => setIncludeMailText(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-line-strong bg-surface-raised text-accent-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-white"
        />
        <span>
          <span className="block text-role-body font-medium text-ink">
            {t("vaultExport.includeText")}
          </span>
          <span className="block text-role-caption text-ink-mid">
            {t("vaultExport.includeText.desc")}
          </span>
        </span>
      </label>
    </div>
  );
}
