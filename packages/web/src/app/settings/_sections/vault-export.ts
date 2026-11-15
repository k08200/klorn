// Klorn Vault export (Settings → Data): the user's own Klorn data as a
// markdown zip, from GET /api/user/me/vault/export (api routes/vault-export.ts).
// Pure helpers, so the panel stays declarative and the rules are testable.

const VAULT_EXPORT_PATH = "/api/user/me/vault/export";
const SECONDS_PER_MINUTE = 60;
/** The server's cooldown; also the cap on what a refusal can claim. */
const COOLDOWN_MINUTES = 10;

/** Shown only when the server opened the export to this user (/me user.vaultExport). */
export function vaultExportVisible(user: { vaultExport?: boolean } | null | undefined): boolean {
  return user?.vaultExport === true;
}

/** The export URL; mail text only when the user turned it on. */
export function vaultExportUrl(apiBase: string, includeMailText: boolean): string {
  return `${apiBase}${VAULT_EXPORT_PATH}${includeMailText ? "?bodies=1" : ""}`;
}

/** klorn-vault-YYYY-MM-DD.zip, by the device's local date. */
export function vaultFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `klorn-vault-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`;
}

export interface VaultExportFailure {
  key: string;
  vars?: Record<string, string>;
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

/** The copy for a refused or failed export. */
export function vaultExportFailure(status: number, body: unknown): VaultExportFailure {
  const code = field(body, "code");
  if (status === 429 && code === "export-in-progress")
    return { key: "vaultExport.error.inProgress" };
  if (status === 429) {
    const seconds = Number(field(body, "retryAfterSeconds"));
    const minutes =
      Number.isFinite(seconds) && seconds > 0
        ? Math.min(COOLDOWN_MINUTES, Math.ceil(seconds / SECONDS_PER_MINUTE))
        : COOLDOWN_MINUTES;
    return { key: "vaultExport.error.cooldown", vars: { minutes: String(minutes) } };
  }
  if (status === 503) return { key: "vaultExport.error.busy" };
  if (status === 404) return { key: "vaultExport.error.unavailable" };
  return { key: "vaultExport.error.failed" };
}
