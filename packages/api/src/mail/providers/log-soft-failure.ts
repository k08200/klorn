/**
 * Read, star and bulk-read routes write the local row whatever the provider
 * answered (an accepted local/remote divergence: the next sync of a provider
 * that supports the action reconciles it). A provider `{ error }` used to be
 * discarded on that path; this logs it. `unsupported` stays silent: it is the
 * expected, per-click answer of a provider with no action surface yet.
 *
 * Logs the local row id, never the provider message id (IMAP ids embed the
 * mailbox address).
 */

export function logProviderSoftFailure(scope: string, rowId: string, result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  const r = result as { error?: unknown; unsupported?: unknown };
  if (r.unsupported === true || typeof r.error !== "string") return;
  console.warn(`[${scope}] provider did not apply the change for ${rowId}: ${r.error}`);
}
