// Settings → Integrations → KakaoTalk import (docs/providers/kakaotalk-import.md
// §7): pure helpers for the panel, free of React so packages/api can test them.

export type KakaoImportStatus = "PENDING" | "PROCESSING" | "DONE" | "FAILED";

export interface KakaoImportSummary {
  id: string;
  status: KakaoImportStatus;
  format: string;
  totalMessages: number;
  windowMessages: number;
  speakerCount: number;
  windowStart: string;
  windowEnd: string;
  candidatesFound: number;
  commitmentsCreated: number;
  duplicatesSkipped: number;
  errorCode: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface KakaoSpeaker {
  name: string;
  total: number;
  inWindow: number;
}

export interface KakaoPreview {
  format: string;
  totalMessages: number;
  windowMessages: number;
  windowTruncated: boolean;
  speakers: KakaoSpeaker[];
  firstAt: string;
  lastAt: string;
  windowStart: string;
  windowEnd: string;
  windowDays: number;
}

/** The API's cap (kakao-import/parse.ts KAKAO_MAX_FILE_BYTES): checked here before uploading. */
export const KAKAO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const KAKAO_UPLOAD_ACCEPT = ".txt,.csv,text/plain,text/csv";

/** The panel shows only while the API's KAKAO_IMPORT_ENABLED opens it to this user (/me). */
export function kakaoImportPanelVisible(
  user: { kakaoImport?: boolean } | null | undefined,
): boolean {
  return user?.kakaoImport === true;
}

/**
 * The import is closed to this user but they still own an import (/me
 * user.kakaoImportWayOut): the panel shows their imports with delete only, no
 * upload, so turning the flag off never traps a chat.
 */
export function kakaoImportWayOutOnly(
  user: { kakaoImport?: boolean; kakaoImportWayOut?: boolean } | null | undefined,
): boolean {
  return user?.kakaoImport !== true && user?.kakaoImportWayOut === true;
}

const KNOWN_ERRORS = new Set([
  "empty-file",
  "file-too-large",
  "unsupported-encoding",
  "zip-not-supported",
  "unknown-format",
  "no-messages",
  "too-many-lines",
  "too-many-messages",
  "too-many-speakers",
  "invalid-upload",
  "consent-required",
  "speaker-not-found",
  "too-many-imports",
  "import-in-progress",
  "busy",
  "not-found",
  "rate-limited",
]);

/** The i18n key for an API error thrown by apiFetch ("API <status>: <body>"). */
export function kakaoImportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  try {
    const body = JSON.parse(message.slice(message.indexOf("{"))) as { code?: unknown };
    return typeof body.code === "string" && KNOWN_ERRORS.has(body.code)
      ? `kakaoImport.error.${body.code}`
      : "kakaoImport.error.generic";
  } catch {
    return "kakaoImport.error.generic";
  }
}

/** Waiting or being read: the panel keeps polling. */
export function kakaoImportActive(summary: KakaoImportSummary): boolean {
  return summary.status === "PENDING" || summary.status === "PROCESSING";
}

export interface KakaoResultLine {
  key: string;
  vars?: Record<string, string>;
}

/** The one-line outcome of an import. */
export function kakaoImportResult(summary: KakaoImportSummary): KakaoResultLine {
  const messages = String(summary.windowMessages);
  if (kakaoImportActive(summary)) return { key: "kakaoImport.result.waiting", vars: { messages } };
  if (summary.status === "FAILED") {
    return {
      key:
        summary.errorCode === "expired"
          ? "kakaoImport.result.expired"
          : "kakaoImport.result.failed",
    };
  }
  const vars = { created: String(summary.commitmentsCreated), messages };
  return summary.errorCode === "partial"
    ? { key: "kakaoImport.result.partial", vars }
    : { key: "kakaoImport.result", vars };
}
