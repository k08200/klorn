/**
 * Files (Files artboard): one list across the sources the deployment has —
 * Klorn Drive, Google Drive (picked files only), mail attachments — with a
 * search over names and contents, a type tile, the AI summary and where each
 * file lives. A source whose routes answer 404 (the drive flags are OFF by
 * default) is simply not offered. Opening goes to the system browser (a
 * Google file's page, a Klorn file's signed download link) or, for an
 * attachment, to its mail. Upload goes to Klorn Drive only, and only while
 * the drive's upload route is on.
 */
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { useInboxes, useMe } from "../../api/queries";
import {
  type AttachmentRow,
  useAttachmentFiles,
  useDriveFile,
  useDriveFiles,
  useDriveLimits,
  useGoogleDriveAccounts,
} from "../../api/queries-hub";
import { getServices } from "../../app/services";
import type { MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { ListDetail } from "../../layout/ListDetail";
import { openExternal } from "../../platform/external";
import { useLinkProps, useRouter } from "../../router/Router";
import { Icon } from "../../ui/Icon";
import { EmptyState, OfflineBanner, ProblemState, SkeletonRows } from "../../ui/StateView";
import { notify } from "../../ui/StatusNote";
import { useNow } from "../../ui/useNow";
import { useOnline } from "../../ui/useOnline";
import { isKnownZone } from "../today/model";
import {
  attachmentDigest,
  type FileItem,
  filterBySource,
  formatSize,
  fromAttachment,
  fromDrive,
  matchesSearch,
  openActionOf,
  type SourceFilter,
  safeHttpsUrl,
  senderName,
  sortItems,
  tileOf,
  type UploadProblem,
  uploadProblemOf,
} from "./model";
import "./files.css";

const SOURCE_KEYS: Record<SourceFilter, MessageKey> = {
  ALL: "files.source.all",
  KLORN: "files.source.klorn",
  GOOGLE: "files.source.google",
  MAIL: "files.source.mail",
};

const CATEGORY_KEYS: Record<string, MessageKey> = {
  contract: "files.category.contract",
  resume: "files.category.resume",
  invoice: "files.category.invoice",
  other: "files.category.other",
};

const UPLOAD_KEYS: Record<UploadProblem, MessageKey> = {
  "too-large": "files.upload.tooLarge",
  "quota-exceeded": "files.upload.quota",
  "quota-not-configured": "files.upload.notReady",
  "rate-limited": "files.upload.busy",
  "storage-unavailable": "files.upload.storage",
  failed: "files.upload.failed",
};

function useDebounced(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** "오늘" / "어제" / "화요일" / "10월 3일" — when a file last changed. */
function useWhen() {
  const { t, intlTag } = useI18n();
  const now = useNow();
  const me = useMe();
  const tz = me.data?.timezone;
  const zone = isKnownZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const key = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(d);
  return (iso: string): string => {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "";
    const days = Math.round((Date.parse(key(now)) - Date.parse(key(date))) / 86_400_000);
    if (days <= 0) return t("files.when.today");
    if (days === 1) return t("files.when.yesterday");
    if (days < 7)
      return new Intl.DateTimeFormat(intlTag, { weekday: "long", timeZone: zone }).format(date);
    return new Intl.DateTimeFormat(intlTag, {
      month: "long",
      day: "numeric",
      timeZone: zone,
    }).format(date);
  };
}

function TypeTile({ item, large = false }: { item: FileItem; large?: boolean }) {
  const tile = tileOf(item.name, item.mimeType);
  return (
    <span
      className={`file-tile file-tile--${tile.kind}${large ? " file-tile--large" : ""}`}
      aria-hidden="true"
    >
      {tile.label}
    </span>
  );
}

function useSourceLine() {
  const { t } = useI18n();
  const when = useWhen();
  const inboxes = useInboxes().data?.inboxes ?? [];
  const google = useGoogleDriveAccounts().data ?? [];
  return (item: FileItem): string => {
    const parts: string[] = [t(SOURCE_KEYS[item.source])];
    if (item.source === "MAIL") parts.push(senderName(item.from));
    if (item.source === "GOOGLE" && item.drive) {
      const email = google.find((a) => a.id === item.drive?.sourceKey)?.email;
      const purpose = inboxes.find(
        (i) => email && i.email?.toLowerCase() === email.toLowerCase(),
      )?.purpose;
      if (purpose === "work") parts.push(t("files.purpose.work"));
      else if (purpose === "personal") parts.push(t("files.purpose.personal"));
      else if (email) parts.push(email);
    }
    parts.push(when(item.modifiedAt));
    return parts.filter(Boolean).join(" · ");
  };
}

function FileRow({
  item,
  selected,
  fetchSummary,
  line,
}: {
  item: FileItem;
  selected: boolean;
  fetchSummary: boolean;
  line: string;
}) {
  const link = useLinkProps({ name: "files", id: item.id });
  // The list has no summaries (server gap): the first rows read theirs (D4).
  const detail = useDriveFile(item.drive ? item.id : null, fetchSummary);
  const summary =
    item.summary ?? (detail.data?.summary?.status === "DONE" ? detail.data.summary.text : null);
  return (
    <li className="file-row" data-selected={selected || undefined}>
      <TypeTile item={item} />
      <span className="file-row__text">
        <a className="file-row__name" {...link} aria-current={selected ? "true" : undefined}>
          {item.name}
        </a>
        {summary ? <span className="file-row__summary">{summary}</span> : null}
        <span className="file-row__meta">{line}</span>
      </span>
    </li>
  );
}

async function openItem(
  item: FileItem,
  navigate: ReturnType<typeof useRouter>["navigate"],
  failed: string,
) {
  const action = openActionOf(item);
  if (action.kind === "mail") {
    navigate({ name: "mail", id: action.emailId });
    return;
  }
  if (action.kind === "link") {
    await openExternal(action.href);
    return;
  }
  if (action.kind === "download") {
    try {
      const { url } = await getServices().ep.files.download(action.id);
      const href = safeHttpsUrl(url);
      if (href) await openExternal(href);
      else notify(failed, "error");
    } catch {
      notify(failed, "error");
    }
  }
}

function FileDetail({ item, line }: { item: FileItem | null; line: string }) {
  const { t, intlTag } = useI18n();
  const { navigate } = useRouter();
  const queryClient = useQueryClient();
  const detail = useDriveFile(item?.drive ? item.id : null);
  const [summarizing, setSummarizing] = useState(false);
  const back = (
    <button type="button" className="detail-back" onClick={() => navigate({ name: "files" })}>
      <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
      {t("tab.files")}
    </button>
  );
  if (!item) {
    return (
      <div className="screen file-detail">
        {back}
        <EmptyState tone="neutral" icon="files" title={t("files.detail.gone")} />
      </div>
    );
  }
  const driveSummary = detail.data?.summary;
  const summaryText = item.summary ?? (driveSummary?.status === "DONE" ? driveSummary.text : null);
  const action = openActionOf(item);
  const size = formatSize(item.size, intlTag);
  const summarize = async () => {
    setSummarizing(true);
    try {
      await getServices().ep.files.summarize(item.id);
      await queryClient.invalidateQueries({ queryKey: ["files", "drive-file", item.id] });
    } catch {
      notify(t("files.detail.summaryFailed"), "error");
    } finally {
      setSummarizing(false);
    }
  };
  return (
    <article className="screen file-detail" aria-labelledby="file-h">
      {back}
      <div className="file-detail__body">
        <TypeTile item={item} large />
        <h1 id="file-h" className="file-detail__name">
          {item.name}
        </h1>
        <p className="file-detail__meta">
          {line}
          {size ? ` · ${size}` : ""}
        </p>
        <section className="file-summary" aria-labelledby="file-sum-h">
          <h2 id="file-sum-h" className="file-summary__title">
            <Icon name="sparkSmall" size={14} />
            {t("files.detail.summary")}
          </h2>
          {summaryText ? (
            <p className="file-summary__text selectable">{summaryText}</p>
          ) : driveSummary?.status === "PENDING" ? (
            <p className="file-summary__muted">{t("files.detail.summaryPending")}</p>
          ) : driveSummary === null ? (
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void summarize()}
              disabled={summarizing}
            >
              {summarizing ? t("files.detail.summarizing") : t("files.detail.summarize")}
            </button>
          ) : (
            <p className="file-summary__muted">{t("files.detail.noSummary")}</p>
          )}
        </section>
        {action.kind === "none" ? null : (
          <button
            type="button"
            className="button button--primary file-detail__open"
            onClick={() => void openItem(item, navigate, t("files.detail.openFailed"))}
          >
            <Icon name={action.kind === "mail" ? "mail" : "external"} size={18} />
            {t(
              action.kind === "mail"
                ? "files.detail.openMail"
                : action.kind === "download"
                  ? "files.detail.download"
                  : "files.detail.openGoogle",
            )}
          </button>
        )}
        {item.source === "GOOGLE" ? (
          <p className="event-detail__note">
            <Icon name="lock" size={16} />
            {t("files.detail.googleReadOnly")}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function FilesScreen({ id }: { id?: string }) {
  const { t, tn, intlTag } = useI18n();
  const online = useOnline();
  const now = useNow();
  const me = useMe();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<SourceFilter>("ALL");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const drive = useDriveFiles(q);
  const limits = useDriveLimits();
  const google = useGoogleDriveAccounts();
  const mailOn = me.data?.hasAnyMailSource !== false;
  const attachments = useAttachmentFiles();
  const line = useSourceLine();

  const klornOn = !!limits.data;
  const googleOn = (google.data?.length ?? 0) > 0;
  const sources: SourceFilter[] = [
    "ALL",
    ...(klornOn ? (["KLORN"] as const) : []),
    ...(googleOn ? (["GOOGLE"] as const) : []),
    ...(mailOn ? (["MAIL"] as const) : []),
  ];
  const activeFilter = sources.includes(filter) ? filter : "ALL";

  const items = useMemo(() => {
    const driveItems = (drive.data ?? []).filter((f) => !f.isFolder).map((f) => fromDrive(f, null));
    const mailItems = mailOn
      ? (attachments.data?.rows ?? []).map((r: AttachmentRow) => fromAttachment(r))
      : [];
    return [...driveItems, ...mailItems];
  }, [drive.data, attachments.data, mailOn]);

  const shown = sortItems(
    filterBySource(items, activeFilter).filter((i) => matchesSearch(i, q)),
    sort,
    intlTag,
  );
  const digest = attachmentDigest(items, now);
  const selected = id ? (items.find((i) => i.id === id) ?? null) : null;

  const loading =
    (drive.isPending && !drive.data) || (mailOn && attachments.isPending && !attachments.data);
  const failed = drive.isError && attachments.isError && !drive.data && !attachments.data;
  const offline =
    !online || [drive.error, attachments.error].some((e) => isApiError(e) && e.isOffline);

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (limits.data && file.size > limits.data.maxFileBytes) {
      notify(t(UPLOAD_KEYS["too-large"]), "error");
      return;
    }
    setUploading(true);
    try {
      await getServices().ep.files.upload(file, file.name);
      notify(t("files.upload.done", { name: file.name }));
      await queryClient.invalidateQueries({ queryKey: ["files"] });
    } catch (err) {
      const problem = isApiError(err) ? uploadProblemOf(err.serverMessage, err.status) : "failed";
      notify(t(UPLOAD_KEYS[problem]), "error");
    } finally {
      setUploading(false);
    }
  };

  const list = (
    <div className="files-pane">
      <header className="files-head">
        <div className="files-head__row">
          <h1 className="screen-title">{t("tab.files")}</h1>
          {klornOn ? (
            <button
              type="button"
              className="round-button"
              onClick={() => picker.current?.click()}
              disabled={uploading}
              aria-busy={uploading || undefined}
            >
              <span className="round-button__face">
                <Icon name="upload" size={18} strokeWidth={2.2} label={t("files.upload.button")} />
              </span>
            </button>
          ) : null}
          <input
            ref={picker}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => void onPick(e)}
          />
        </div>
        <label className="files-search">
          <Icon name="search" size={17} strokeWidth={2} />
          <span className="sr-only">{t("files.search.label")}</span>
          <input
            type="search"
            value={search}
            placeholder={t("files.search.placeholder")}
            onChange={(e) => setSearch(e.target.value)}
            enterKeyHint="search"
          />
        </label>
        <div className="files-sources" role="group" aria-label={t("files.source.label")}>
          {sources.map((s) => (
            <button
              key={s}
              type="button"
              className="files-source"
              aria-pressed={s === activeFilter}
              onClick={() => setFilter(s)}
            >
              {t(SOURCE_KEYS[s])}
            </button>
          ))}
        </div>
      </header>
      <div className="files-scroll">
        {offline ? <OfflineBanner /> : null}
        {uploading ? (
          <p className="files-uploading" role="status">
            {t("files.upload.working")}
          </p>
        ) : null}
        {digest.total > 0 && !q.trim() && (activeFilter === "ALL" || activeFilter === "MAIL") ? (
          <button type="button" className="files-digest" onClick={() => setFilter("MAIL")}>
            <span className="files-digest__icon" aria-hidden="true">
              <Icon name="paperclip" size={18} strokeWidth={1.9} />
            </span>
            <span className="files-digest__text">
              <span className="files-digest__title">{tn("files.digest.title", digest.total)}</span>
              <span className="files-digest__sub">
                {digest.byCategory
                  .map(
                    (c) => `${t(CATEGORY_KEYS[c.category] ?? "files.category.other")} ${c.count}`,
                  )
                  .join(" · ")}
              </span>
            </span>
            <Icon name="chevronRight" size={16} strokeWidth={2} className="files-digest__chevron" />
          </button>
        ) : null}
        <div className="files-listhead">
          <h2 className="files-listhead__title">
            {q.trim() ? t("files.results", { q: q.trim() }) : t("files.recent")}
          </h2>
          <button
            type="button"
            className="files-sort"
            onClick={() => setSort((s) => (s === "recent" ? "name" : "recent"))}
          >
            {t(sort === "recent" ? "files.sort.recent" : "files.sort.name")}
            <Icon name="chevronDown" size={12} strokeWidth={2.2} />
          </button>
        </div>
        {failed ? (
          <ProblemState
            kind={offline ? "offline" : "error"}
            onRetry={() => {
              void drive.refetch();
              void attachments.refetch();
            }}
          />
        ) : loading ? (
          <div aria-busy="true">
            <SkeletonRows rows={3} />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            tone="neutral"
            icon="files"
            title={t(q.trim() ? "files.empty.search" : "files.empty.title")}
            body={q.trim() ? undefined : t("files.empty.body")}
          />
        ) : (
          <ul className="file-list card" aria-label={t("files.listLabel")}>
            {shown.map((item, i) => (
              <FileRow
                key={item.id}
                item={item}
                selected={item.id === id}
                fetchSummary={i < 10}
                line={line(item)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <ListDetail
      list={list}
      detail={id ? <FileDetail item={selected} line={selected ? line(selected) : ""} /> : null}
      emptyDetail={
        <div className="screen pane-empty">
          <EmptyState tone="neutral" icon="files" title={t("files.detail.pick")} />
        </div>
      }
      listLabel={t("files.listLabel")}
      detailLabel={t("files.detail.label")}
    />
  );
}
