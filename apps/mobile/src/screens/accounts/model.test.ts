import type { InboxOption } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import { MOCK_INBOXES } from "../../api/mock/fixtures";
import {
  availableProviders,
  connectedInboxes,
  disconnectOf,
  imapFormProblem,
  providerTitleKey,
  statusOf,
} from "./model";

const [primary, work, , naver, icloud] = MOCK_INBOXES.inboxes;
// The fixtures connect no Outlook account (dark in production); one for the model.
const outlook: InboxOption = {
  id: "inbox-outlook",
  email: "jisu@partners.example",
  kind: "linked",
  needsReconnect: false,
  provider: "OUTLOOK",
  purpose: "work",
};

describe("accounts", () => {
  it("names accounts and marks Outlook, Naver and iCloud as beta", () => {
    expect(primary && providerTitleKey(primary)).toBe("accounts.provider.gmail");
    expect(work && providerTitleKey(work)).toBe("accounts.provider.workspace");
    expect(outlook && statusOf(outlook)).toBe("beta");
    expect(naver && statusOf(naver)).toBe("beta");
    expect(icloud && statusOf(icloud)).toBe("reconnect");
    expect(work && statusOf(work)).toBe("connected");
  });

  it("disconnects each provider through its own route", () => {
    expect(primary && disconnectOf(primary)).toEqual({ kind: "primaryGoogle" });
    expect(work && disconnectOf(work)).toEqual({ kind: "linkedGoogle", id: "inbox-work" });
    expect(outlook && disconnectOf(outlook)).toEqual({ kind: "outlook", id: "inbox-outlook" });
    expect(naver && disconnectOf(naver)).toEqual({
      kind: "imap",
      imap: "naver",
      email: "jisu@naver.example",
    });
  });

  it("offers only the providers whose routes answer", () => {
    expect(availableProviders({ NAVER: true })).toEqual(["GOOGLE", "NAVER"]);
    expect(
      availableProviders({ OUTLOOK: true, ICLOUD: true, IMAP: true, NAVER: true }),
    ).toHaveLength(5);
  });

  it("drops a primary row that has no Google grant", () => {
    expect(connectedInboxes(MOCK_INBOXES.inboxes, false).map((i) => i.id)).not.toContain(null);
    expect(connectedInboxes(MOCK_INBOXES.inboxes, true)).toHaveLength(5);
  });

  it("validates the IMAP form before connecting", () => {
    expect(imapFormProblem({ email: "x", password: "pw12", host: "" }, false)).toBe("email");
    expect(imapFormProblem({ email: "a@b.co", password: "pw", host: "" }, false)).toBe("password");
    expect(imapFormProblem({ email: "a@b.co", password: "pw12", host: "" }, true)).toBe("host");
    expect(
      imapFormProblem({ email: "a@b.co", password: "pw12", host: "imap.b.co" }, true),
    ).toBeNull();
  });
});
