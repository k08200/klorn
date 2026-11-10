/**
 * Sender label correction in the Mail v2 reader — the pure half. No React and
 * no DOM, so the api vitest suite pins it
 * (packages/api/src/__tests__/web-sender-label-model.test.ts).
 *
 * A sender label is the user's correction of who a sender IS ("this address is
 * a customer", "everyone at acme.io is an investor"). It is evidence the
 * classifier reads, not an action. The server decides the address and the
 * domain (ReaderSenderLabel); this module only arranges the choices and the
 * request, and never derives a domain itself.
 */

import type { ReaderSenderLabel, SenderLabelCategory, SenderLabelScope } from "@klorn/contract";

/** The categories a user can pin, in menu order (the server's USER_LABEL_CATEGORIES). */
export const SENDER_LABEL_CATEGORIES: readonly SenderLabelCategory[] = [
  "internal",
  "customer",
  "investor",
  "system",
  "billing",
  "promotions",
];

export type SenderLabelChange =
  | { kind: "set"; scope: SenderLabelScope; category: SenderLabelCategory }
  | { kind: "clear"; scope: SenderLabelScope };

export interface SenderLabelChoice {
  id: string;
  category: SenderLabelCategory;
  /** This category is the user's own correction at this scope. */
  checked: boolean;
  change: SenderLabelChange;
}

export interface SenderLabelOptions {
  /** "This address is …" */
  address: SenderLabelChoice[];
  /** "Everyone at <domain> is …"; null when the server offers no domain. */
  domain: { value: string; choices: SenderLabelChoice[] } | null;
  /** The correction in effect, which "clear" removes; null = nothing of the user's to clear. */
  clear: SenderLabelScope | null;
}

function choicesFor(label: ReaderSenderLabel, scope: SenderLabelScope): SenderLabelChoice[] {
  return SENDER_LABEL_CATEGORIES.map((category) => ({
    id: `${scope}:${category}`,
    category,
    checked: label.correction === scope && label.current === category,
    change: { kind: "set", scope, category },
  }));
}

export function senderLabelOptions(label: ReaderSenderLabel): SenderLabelOptions {
  return {
    address: choicesFor(label, "sender"),
    domain: label.domain ? { value: label.domain, choices: choicesFor(label, "domain") } : null,
    clear: label.correction,
  };
}

/**
 * The optimistic state after a change. A clear claims no label until the
 * server answers with the evidence underneath (or a remaining domain label).
 */
export function applySenderLabelChange(
  label: ReaderSenderLabel,
  change: SenderLabelChange,
): ReaderSenderLabel {
  if (change.kind === "set") {
    return { ...label, current: change.category, correction: change.scope };
  }
  if (label.correction !== change.scope) return label;
  return { ...label, current: null, correction: null };
}

export interface SenderLabelRequest {
  method: "PUT" | "DELETE";
  path: string;
  body?: string;
}

const SENDER_LABELS_PATH = "/api/email/sender-labels";

/**
 * The request for a change, or null when it targets nothing the server
 * offered (a domain change for a public mail provider). The value is always
 * the server's own address / domain; the server re-validates it and scopes
 * the row to the signed-in user.
 */
export function senderLabelRequest(
  label: ReaderSenderLabel,
  change: SenderLabelChange,
): SenderLabelRequest | null {
  const value = change.scope === "sender" ? label.address : label.domain;
  if (!value) return null;
  if (change.kind === "set") {
    return {
      method: "PUT",
      path: SENDER_LABELS_PATH,
      body: JSON.stringify({ scope: change.scope, value, category: change.category }),
    };
  }
  const query = new URLSearchParams({ scope: change.scope, value });
  return { method: "DELETE", path: `${SENDER_LABELS_PATH}?${query.toString()}` };
}
