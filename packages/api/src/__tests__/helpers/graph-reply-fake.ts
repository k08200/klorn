/**
 * A stateful stand-in for the Microsoft Graph calls a native Outlook reply makes
 * (step B0b). It keeps the reply DRAFT's state, so what a test asserts about
 * recipients, subject and body is what a real draft would hold at send time:
 *   - createReply answers a draft addressed to the original's Reply-To, with a quoted
 *     HTML body, as the docs describe;
 *   - PATCH replaces the fields it is given and answers the whole draft, with the body
 *     in the lowercase `text` / `html` form Graph answers with;
 *   - the attachment list of the new draft is empty unless a test puts something in it.
 * A call no handler covers throws, so an unexpected request is loud.
 */

import type { Mock } from "vitest";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const MAILBOX = "me@outlook.com";
export const ORIGINAL_ID = `outlook:${MAILBOX}:ORIG`;
export const WEB_LINK = "https://outlook.live.com/mail/0/drafts/id/DRAFT";
export const REPLY_TO_ADDRESS = "reply-to@elsewhere.test";
export const LIST_ATTACHMENTS = "GET /me/messages/DRAFT/attachments?$select=id";

export const address = (value: string) => ({ emailAddress: { address: value } });

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** The body is not JSON: `response.json()` rejects. */
  unreadable?: boolean;
}

export interface DraftState {
  id: string;
  toRecipients: Array<{ emailAddress: { address: string } }>;
  ccRecipients: unknown[];
  bccRecipients: unknown[];
  subject: string;
  body: { contentType: string; content: string };
}

export type Handler = (call: RecordedCall, draft: DraftState) => FakeResponse;

const freshDraft = (): DraftState => ({
  id: "DRAFT",
  toRecipients: [address(REPLY_TO_ADDRESS)],
  ccRecipients: [],
  bccRecipients: [],
  subject: "RE: Plan",
  body: { contentType: "html", content: "<html>quoted original</html>" },
});

export function createGraphFake(fetchMock: Mock) {
  let calls: RecordedCall[] = [];
  let draft = freshDraft();
  let sentSnapshot: DraftState | null = null;

  const defaults: Record<string, Handler> = {
    "POST /me/messages/ORIG/createReply": (_call, state) => ({
      status: 201,
      body: { ...state, webLink: WEB_LINK, isDraft: true },
    }),
    "PATCH /me/messages/DRAFT": (call, state) => {
      Object.assign(state, call.body as object);
      return {
        status: 200,
        body: {
          ...state,
          body: { ...state.body, contentType: state.body.contentType.toLowerCase() },
        },
      };
    },
    [LIST_ATTACHMENTS]: () => ({ status: 200, body: { value: [] } }),
    "POST /me/messages/DRAFT/attachments": () => ({ status: 201, body: { id: "ATT" } }),
    "POST /me/messages/DRAFT/send": (_call, state) => {
      sentSnapshot = structuredClone(state);
      return { status: 202 };
    },
    "DELETE /me/messages/DRAFT": () => ({ status: 204 }),
  };

  function install(overrides: Record<string, Handler> = {}) {
    const handlers = { ...defaults, ...overrides };
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const call: RecordedCall = {
        method: String(init.method),
        path: url.replace(GRAPH_BASE, ""),
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        signal: init.signal ?? undefined,
      };
      calls = [...calls, call];
      const handler =
        handlers[`${call.method} ${call.path}`] ??
        // Deleting any attachment of the draft succeeds unless a test says otherwise.
        (call.method === "DELETE" && call.path.startsWith("/me/messages/DRAFT/attachments/")
          ? () => ({ status: 204 })
          : undefined);
      if (!handler) throw new Error(`unscripted Graph call: ${call.method} ${call.path}`);
      const { status, body, unreadable } = handler(call, draft);
      return {
        ok: status < 400,
        status,
        json: async () => {
          if (unreadable) throw new SyntaxError("Unexpected token < in JSON");
          return body ?? null;
        },
      };
    });
  }

  return {
    /** Forget every call and start from a fresh createReply draft. */
    reset() {
      calls = [];
      draft = freshDraft();
      sentSnapshot = null;
      install();
    },
    install,
    get calls() {
      return calls;
    },
    get draft() {
      return draft;
    },
    /** The draft as it was when `/send` was called, or null if it never was. */
    get sentSnapshot() {
      return sentSnapshot;
    },
    summary: () => calls.map((call) => `${call.method} ${call.path}`),
  };
}
