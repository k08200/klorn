"use client";

// Settings → Integrations → KakaoTalk import (docs/providers/kakaotalk-import.md
// §7). Shown only while the API's KAKAO_IMPORT_ENABLED opens it to this user
// (/me user.kakaoImport). One-shot: export a chat in KakaoTalk, check the file
// (nothing is stored), pick your own name, consent that the file holds other
// people's messages, import. Suggestions land in Commitments → To confirm.

import { useCallback, useEffect, useId, useState } from "react";
import { useConfirm } from "../../../components/confirm-dialog";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import StatusChip from "../../../components/ui/status-chip";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import {
  KAKAO_UPLOAD_ACCEPT,
  KAKAO_UPLOAD_MAX_BYTES,
  type KakaoImportSummary,
  type KakaoPreview,
  kakaoImportActive,
  kakaoImportFailure,
  kakaoImportPanelVisible,
  kakaoImportResult,
} from "./kakao-import-settings";
import { PANEL } from "./shared";

const POLL_MS = 4_000;
const BASE = "/api/kakao-import";
const OPTION = "flex min-h-11 cursor-pointer items-center gap-3 text-role-body text-ink";
const RADIO = "size-4 shrink-0 accent-accent-solid focus-ring";
const FILE_INPUT =
  "block w-full min-h-11 text-role-body text-ink-mid file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-control file:border file:border-line-strong file:bg-surface-panel file:px-4 file:text-ink hover:file:bg-surface-hover focus-ring";

function useKakaoImports(enabled: boolean) {
  const [imports, setImports] = useState<KakaoImportSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const reload = useCallback(async () => {
    try {
      const body = await apiFetch<{ imports: KakaoImportSummary[] }>(BASE);
      setImports(body.imports);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  const polling = enabled && (imports ?? []).some(kakaoImportActive);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, reload]);
  return { imports, reload, loadFailed };
}

function ExportSteps() {
  const { t } = useT();
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-2 text-role-body text-ink">
        {t("kakaoImport.howTo.title")}
      </summary>
      <ul className="list-disc space-y-1 pl-5 text-role-body text-ink-mid">
        <li>{t("kakaoImport.howTo.mobile")}</li>
        <li>{t("kakaoImport.howTo.pc")}</li>
      </ul>
    </details>
  );
}

function SpeakerPicker({
  preview,
  me,
  onPick,
}: {
  preview: KakaoPreview;
  me: string | null;
  onPick: (name: string) => void;
}) {
  const { t } = useT();
  const group = useId();
  return (
    <fieldset className="min-w-0 max-h-80 space-y-1 overflow-y-auto">
      <legend className="text-role-label text-ink">{t("kakaoImport.me.legend")}</legend>
      {preview.speakers.map((speaker) => (
        <label key={speaker.name} className={OPTION}>
          <input
            type="radio"
            name={group}
            value={speaker.name}
            checked={me === speaker.name}
            onChange={() => onPick(speaker.name)}
            className={RADIO}
          />
          <span className="min-w-0">
            <span className="block truncate">{speaker.name}</span>
            <span className="block text-role-caption text-ink-mid">
              {t("kakaoImport.me.count", { count: String(speaker.inWindow) })}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function PreviewSummary({ preview }: { preview: KakaoPreview }) {
  const { t } = useT();
  return (
    <p className="text-role-body text-ink-mid">
      {t("kakaoImport.previewSummary", {
        total: String(preview.totalMessages),
        window: String(preview.windowMessages),
        days: String(preview.windowDays),
      })}
      {preview.windowTruncated ? ` ${t("kakaoImport.truncated")}` : ""}
    </p>
  );
}

function formFor(file: File, fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append("file", file);
  return form;
}

function ConsentCheck({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useT();
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control px-2 py-2 transition hover:bg-surface-hover"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-accent-solid focus-ring"
      />
      <span className="text-role-body text-ink">{t("kakaoImport.consent")}</span>
    </label>
  );
}

/** The upload's state and its two requests: check (preview) and import. */
function useUploadFlow(onImported: () => Promise<void>) {
  const { t } = useT();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [preview, setPreview] = useState<KakaoPreview | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  // A new file (or none) starts over: its preview, the speaker and the consent were for the old one.
  const startOver = (next: File | null) => {
    setFile(next);
    setPreview(null);
    setMe(null);
    setConsent(false);
    if (next === null) setInputKey((key) => key + 1);
  };

  const pick = (picked: File | null) => {
    if (picked && picked.size > KAKAO_UPLOAD_MAX_BYTES) {
      toast(t("kakaoImport.error.file-too-large"), "error");
      startOver(null);
      return;
    }
    startOver(picked);
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      toast(t(kakaoImportFailure(err)), "error");
    } finally {
      setBusy(false);
    }
  };

  const check = (selected: File) =>
    run(async () => {
      const body = await apiFetch<{ preview: KakaoPreview }>(`${BASE}/preview`, {
        method: "POST",
        body: formFor(selected),
      });
      setPreview(body.preview);
    });

  const startImport = (selected: File, speaker: string) =>
    run(async () => {
      await apiFetch(BASE, {
        method: "POST",
        body: formFor(selected, { consent: "true", me: speaker }),
      });
      toast(t("kakaoImport.imported"), "success");
      startOver(null);
      await onImported();
    });

  return {
    file,
    inputKey,
    preview,
    me,
    setMe,
    consent,
    setConsent,
    busy,
    pick,
    check,
    startImport,
    startOver,
  };
}

function UploadForm({ onImported }: { onImported: () => Promise<void> }) {
  const { t } = useT();
  const fileId = useId();
  const flow = useUploadFlow(onImported);
  const { file, preview, me, busy } = flow;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={fileId} className="block text-role-label text-ink">
          {t("kakaoImport.file")}
        </label>
        <input
          key={flow.inputKey}
          id={fileId}
          type="file"
          accept={KAKAO_UPLOAD_ACCEPT}
          disabled={busy}
          onChange={(event) => flow.pick(event.target.files?.[0] ?? null)}
          className={FILE_INPUT}
        />
      </div>
      {file && !preview && (
        <Button variant="secondary" onClick={() => void flow.check(file)} loading={busy}>
          {t("kakaoImport.preview")}
        </Button>
      )}
      {file && preview && (
        <div className="space-y-3">
          <PreviewSummary preview={preview} />
          <SpeakerPicker preview={preview} me={me} onPick={flow.setMe} />
          <ConsentCheck checked={flow.consent} disabled={busy} onChange={flow.setConsent} />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => (me ? void flow.startImport(file, me) : undefined)}
              disabled={!me || !flow.consent}
              loading={busy}
            >
              {t("kakaoImport.import")}
            </Button>
            <Button variant="ghost" onClick={() => flow.startOver(null)} disabled={busy}>
              {t("kakaoImport.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const CHIP: Record<KakaoImportSummary["status"], "connected" | "failed" | "pending"> = {
  PENDING: "pending",
  PROCESSING: "pending",
  DONE: "connected",
  FAILED: "failed",
};

function ImportRow({
  item,
  onDeleted,
}: {
  item: KakaoImportSummary;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useT();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState(false);
  const result = kakaoImportResult(item);

  const remove = async () => {
    const ok = await confirm({
      title: t("kakaoImport.delete.title"),
      message: t("kakaoImport.delete.message"),
      confirmLabel: t("kakaoImport.delete"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch(`${BASE}/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      toast(t("kakaoImport.deleted"), "success");
      await onDeleted();
    } catch (err) {
      toast(t(kakaoImportFailure(err)), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={CHIP[item.status]} label={t(`kakaoImport.status.${item.status}`)} />
          <span className="text-role-caption text-ink-mid">
            {t("kakaoImport.importedAt", { time: new Date(item.createdAt).toLocaleString() })}
          </span>
        </div>
        <p className="text-role-body text-ink">{t(result.key, result.vars)}</p>
      </div>
      <Button variant="danger" onClick={() => void remove()} loading={busy}>
        {t("kakaoImport.delete")}
      </Button>
    </li>
  );
}

function ImportList({
  imports,
  loadFailed,
  reload,
}: {
  imports: KakaoImportSummary[] | null;
  loadFailed: boolean;
  reload: () => Promise<void>;
}) {
  const { t } = useT();
  if (loadFailed) {
    return (
      <div className="flex items-center justify-between gap-4">
        <p className="text-role-body text-ink-mid">{t("kakaoImport.error.generic")}</p>
        <Button variant="secondary" onClick={() => void reload()}>
          {t("kakaoImport.retry")}
        </Button>
      </div>
    );
  }
  if (!imports || imports.length === 0) return null;
  return (
    <div>
      <h4 className="text-role-label text-ink">{t("kakaoImport.history.title")}</h4>
      <ul className="divide-y divide-line/70" aria-live="polite">
        {imports.map((item) => (
          <ImportRow key={item.id} item={item} onDeleted={reload} />
        ))}
      </ul>
    </div>
  );
}

export function KakaoImportPanel() {
  const { user } = useAuth();
  const { t } = useT();
  const visible = kakaoImportPanelVisible(user);
  const { imports, reload, loadFailed } = useKakaoImports(visible);

  if (!visible) return null;
  return (
    <section className="mb-8">
      <div className={`${PANEL} space-y-4 p-4`}>
        <div>
          <h3 className="font-medium">{t("kakaoImport.title")}</h3>
          <p className="text-role-body text-ink-mid">{t("kakaoImport.desc")}</p>
        </div>
        <ExportSteps />
        <UploadForm onImported={reload} />
        <ImportList imports={imports} loadFailed={loadFailed} reload={reload} />
      </div>
    </section>
  );
}
