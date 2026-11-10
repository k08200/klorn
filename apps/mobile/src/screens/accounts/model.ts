/**
 * Accounts & sources — the pure half: how each connected account is named,
 * which status it shows (Outlook, Naver and iCloud are beta), how it is
 * disconnected, and which "add" flows a deployment offers. No React
 * (model.test.ts).
 */
import type { InboxOption, InboxProvider } from "@klorn/contract";
import type { ImapKind } from "../../api/endpoints";
import type { MessageKey } from "../../i18n";

export const BETA_PROVIDERS: ReadonlySet<InboxProvider> = new Set(["OUTLOOK", "NAVER", "ICLOUD"]);

export type AccountStatus = "connected" | "beta" | "reconnect";

export function statusOf(inbox: Pick<InboxOption, "provider" | "needsReconnect">): AccountStatus {
  if (inbox.needsReconnect) return "reconnect";
  return BETA_PROVIDERS.has(inbox.provider) ? "beta" : "connected";
}

/** The account's name in the list (its address is the second line). */
export function providerTitleKey(inbox: Pick<InboxOption, "provider" | "purpose">): MessageKey {
  switch (inbox.provider) {
    case "GOOGLE":
      return inbox.purpose === "work" ? "accounts.provider.workspace" : "accounts.provider.gmail";
    case "OUTLOOK":
      return "accounts.provider.outlook";
    case "NAVER":
      return "accounts.provider.naver";
    case "ICLOUD":
      return "accounts.provider.icloud";
    default:
      return "accounts.provider.imap";
  }
}

export const IMAP_KIND: Partial<Record<InboxProvider, ImapKind>> = {
  NAVER: "naver",
  ICLOUD: "icloud",
  IMAP: "generic",
};

/** How an inbox is disconnected (each provider has its own route). */
export type Disconnect =
  | { kind: "primaryGoogle" }
  | { kind: "linkedGoogle"; id: string }
  | { kind: "outlook"; id: string }
  | { kind: "imap"; imap: ImapKind; email: string }
  | { kind: "none" };

export function disconnectOf(inbox: InboxOption): Disconnect {
  if (inbox.kind === "primary")
    return inbox.provider === "GOOGLE" ? { kind: "primaryGoogle" } : { kind: "none" };
  const imap = IMAP_KIND[inbox.provider];
  if (imap) return inbox.email ? { kind: "imap", imap, email: inbox.email } : { kind: "none" };
  if (!inbox.id) return { kind: "none" };
  return inbox.provider === "OUTLOOK"
    ? { kind: "outlook", id: inbox.id }
    : { kind: "linkedGoogle", id: inbox.id };
}

/** Providers the "Add account" sheet can offer, in the artboard's order. */
export type AddProvider = "GOOGLE" | "OUTLOOK" | "NAVER" | "ICLOUD" | "IMAP";
export const ADD_ORDER: readonly AddProvider[] = ["GOOGLE", "OUTLOOK", "NAVER", "ICLOUD", "IMAP"];

/** A route that answered (anything but a 404 / null) means the provider is on here. */
export function availableProviders(
  available: Partial<Record<AddProvider, boolean>>,
): AddProvider[] {
  return ADD_ORDER.filter((p) => p === "GOOGLE" || available[p] === true);
}

/** The primary Google row exists even with no Google grant; only list it when it is a real source. */
export function connectedInboxes(
  inboxes: readonly InboxOption[],
  googleConnected: boolean | undefined,
): InboxOption[] {
  return inboxes.filter((i) => i.kind === "linked" || googleConnected !== false);
}

/** IMAP connect input, validated before any network call. */
export function imapFormProblem(
  form: { email: string; password: string; host: string },
  needsHost: boolean,
): "email" | "password" | "host" | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return "email";
  if (form.password.length < 4) return "password";
  if (needsHost && !/^[A-Za-z0-9.-]{3,253}$/.test(form.host.trim())) return "host";
  return null;
}
