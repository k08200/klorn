/**
 * Web rendering of meeting prep in the briefing card: every line links to its
 * own source (the mail, or the commitment ledger), a suggestion is labelled
 * as one, and every string it uses exists in all seven locales.
 * Run from the api suite because the web package has no unit-test runner.
 */

import type { MeetingPrepItem } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import {
  PREP_LOCALE_KEYS,
  prepItemLine,
} from "../../../web/src/app/assistant/briefing/meeting-prep-lines";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";

const t = (key: string, vars: Record<string, string> = {}) =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
const formatDay = () => "Fri, Mar 6";

const items: MeetingPrepItem[] = [
  {
    kind: "commitment",
    owner: "USER",
    title: "Send the quote",
    dueAt: "2099-03-06T09:00:00.000Z",
    confirmed: true,
    counterpartyName: "Alice",
    match: "address",
    source: { kind: "commitment", commitmentId: "c-1" },
  },
  {
    kind: "commitment",
    owner: "COUNTERPARTY",
    title: "Signed NDA",
    dueAt: null,
    confirmed: false,
    counterpartyName: null,
    match: "domain",
    source: { kind: "commitment", commitmentId: "c-2" },
  },
  {
    kind: "unanswered",
    from: "Alice",
    subject: "Quote request",
    receivedAt: "2099-03-01T01:00:00.000Z",
    match: "address",
    source: { kind: "email", emailId: "m/1" },
  },
  {
    kind: "thread",
    from: "Bob",
    subject: "",
    receivedAt: "2099-02-28T01:00:00.000Z",
    match: "domain",
    source: { kind: "email", emailId: "m-2" },
  },
];

describe("prepItemLine", () => {
  it("renders each item with a link to its own source", () => {
    const lines = items.map((item) => prepItemLine(item, t, formatDay));
    expect(lines.map((l) => l.href)).toEqual([
      "/assistant/approvals#hub-commitments",
      "/assistant/approvals#hub-commitments",
      "/email/m%2F1",
      "/email/m-2",
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      "You promised: Send the quote (by Fri, Mar 6)",
      "Suggestion: The other side owes you: Signed NDA",
      "Unanswered: Alice — Quote request",
      "Recent: Bob — (no subject)",
    ]);
    for (const line of lines) expect(en[line.linkLabelKey]).toBeTruthy();
  });
});

describe("locale parity for meeting prep", () => {
  it.each([
    ["de", de],
    ["en", en],
    ["es", es],
    ["fr", fr],
    ["ja", ja],
    ["ko", ko],
    ["zh", zh],
  ])("%s has every key", (_lang, table) => {
    for (const key of PREP_LOCALE_KEYS) expect(table[key], key).toBeTruthy();
  });
});
