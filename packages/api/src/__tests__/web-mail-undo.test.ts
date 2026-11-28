/**
 * docs/design/mail-cleanup-actions.md, PR1 — the web's undo of a trash or
 * archive names the mail's own account, and a bulk archive that partly failed
 * keeps the undo of what did leave (packages/web/src/app/email/mail-undo.ts).
 */

import { describe, expect, it } from "vitest";
import {
  readUndoAccount,
  splitBulkOutcome,
  UNDO_ACCOUNT_PARAM,
  undoRequest,
  writeUndoAccount,
} from "../../../web/src/app/email/mail-undo";

describe("undoRequest", () => {
  it("names the linked account the mail lived in", () => {
    expect(
      undoRequest({ action: "archive", gmailId: "gm-1", linkedInboxAccountId: "acc-2" }),
    ).toEqual({
      path: "/api/email/gm-1/archive/undo",
      body: { gmailId: "gm-1", linkedInboxAccountId: "acc-2" },
    });
  });

  it("sends no account for primary mail (the server's primary, as before)", () => {
    expect(undoRequest({ action: "delete", gmailId: "gm-1", linkedInboxAccountId: null })).toEqual({
      path: "/api/email/gm-1/delete/undo",
      body: { gmailId: "gm-1" },
    });
  });

  it("encodes a provider-prefixed id in the path", () => {
    const id = "outlook:me@outlook.com:AAMk/1=";
    expect(undoRequest({ action: "delete", gmailId: id, linkedInboxAccountId: "o1" }).path).toBe(
      `/api/email/${encodeURIComponent(id)}/delete/undo`,
    );
  });
});

describe("the reader's undo hand-off carries the account", () => {
  it("round-trips through the URL", () => {
    const params = new URLSearchParams();
    writeUndoAccount(params, "acc-2");
    expect(params.get(UNDO_ACCOUNT_PARAM)).toBe("acc-2");
    expect(readUndoAccount(params)).toBe("acc-2");
  });

  it("writes nothing for primary mail and reads a missing or blank value as primary", () => {
    const params = new URLSearchParams();
    writeUndoAccount(params, null);
    expect(params.has(UNDO_ACCOUNT_PARAM)).toBe(false);
    expect(readUndoAccount(params)).toBeNull();
    expect(readUndoAccount(new URLSearchParams(`${UNDO_ACCOUNT_PARAM}=%20`))).toBeNull();
    expect(readUndoAccount(null)).toBeNull();
  });
});

describe("splitBulkOutcome", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("keeps the order and splits by the failed ids", () => {
    expect(splitBulkOutcome(rows, [{ id: "b" }])).toEqual({
      succeeded: [{ id: "a" }, { id: "c" }],
      failed: [{ id: "b" }],
    });
  });

  it("is all success with no failures and all failure when every id failed", () => {
    expect(splitBulkOutcome(rows, []).failed).toEqual([]);
    expect(splitBulkOutcome(rows, rows).succeeded).toEqual([]);
  });

  it("ignores failed ids it was not given", () => {
    expect(splitBulkOutcome(rows, [{ id: "zzz" }]).succeeded).toHaveLength(3);
  });
});
