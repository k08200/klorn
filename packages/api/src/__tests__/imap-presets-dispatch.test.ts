/**
 * The presets in every per-provider list that is not driven by the registry: the
 * action dispatcher (dark while IMAP_PRESETS_ENABLED is off, whatever the IMAP action
 * flags say; real send/flags/moves once on), the IMAP error family, Account Health
 * and the reconnect alert copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  linkedFindMany: vi.fn(),
  tokenFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: { findFirst: h.findFirst, findMany: h.linkedFindMany },
    userToken: { findFirst: h.tokenFindFirst },
    user: { findUnique: h.userFindUnique },
  };
  return { prisma, db: prisma };
});
vi.mock("nodemailer", () => ({ createTransport: h.createTransport }));
vi.mock("imapflow", () => ({ ImapFlow: class {} }));
vi.mock("../crypto-tokens.js", () => ({ decryptToken: () => "pw" }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { mailActionsForProvider } = await import("../mail/providers/dispatch.js");
const { isImapFamily } = await import("../mail/providers/error-semantics.js");
const { listAccountHealth } = await import("../mail/account-health.js");
const { reconnectProviderLabel } = await import("../notify/reconnect-notification.js");
const { IMAP_PRESET_KEYS } = await import("../mail/imap-preset-keys.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

const FLAGS = [
  "IMAP_PRESETS_ENABLED",
  "IMAP_SEND_ENABLED",
  "IMAP_ACTIONS_ENABLED",
  "IMAP_MOVE_ACTIONS_ENABLED",
] as const;
const original = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

function setFlags(values: Partial<Record<(typeof FLAGS)[number], string>>) {
  for (const name of FLAGS) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(() => {
  setFlags({});
  vi.clearAllMocks();
});
afterEach(() => {
  for (const name of FLAGS) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const ALL_ACTIONS_ON = {
  IMAP_SEND_ENABLED: "true",
  IMAP_ACTIONS_ENABLED: "true",
  IMAP_MOVE_ACTIONS_ENABLED: "true",
} as const;

describe("mail action dispatch for the presets", () => {
  it.each(
    IMAP_PRESET_KEYS,
  )("%s: every action is unsupported while the preset flag is off", async (key) => {
    setFlags(ALL_ACTIONS_ON);
    const actions = mailActionsForProvider(key);
    expect(actions.provider).toBe(key);
    expect(await actions.sendEmail("u1", "bob@example.com", "s", "b")).toMatchObject({
      unsupported: true,
    });
    expect(await actions.markAsRead("u1", "id", "row")).toMatchObject({ unsupported: true });
    expect(await actions.archive("u1", "id", "row")).toMatchObject({ unsupported: true });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it.each(
    IMAP_PRESET_KEYS,
  )("%s: the real send, flag and move actions once the flag is on", async (key) => {
    setFlags({ ...ALL_ACTIONS_ON, IMAP_PRESETS_ENABLED: "true" });
    const actions = mailActionsForProvider(key);
    const needsRow = { error: `${IMAP_PROVIDERS[key].label} actions need the linked mailbox id.` };
    expect(actions.provider).toBe(key);
    expect(await actions.sendEmail("u1", "bob@example.com", "s", "b")).toEqual(needsRow);
    expect(await actions.markAsRead("u1", "id", null)).toEqual(needsRow);
    expect(await actions.archive("u1", "id", null)).not.toHaveProperty("unsupported");
    expect(h.createTransport).not.toHaveBeenCalled();
  });
});

describe("other per-provider lists", () => {
  it("every preset is in the IMAP error family", () => {
    for (const key of IMAP_PRESET_KEYS) expect(isImapFamily(key)).toBe(true);
    expect(isImapFamily("GOOGLE")).toBe(false);
  });

  it("Account Health reports a preset account as that preset, never as Gmail", async () => {
    h.userFindUnique.mockResolvedValue({ email: "me@example.com" });
    h.tokenFindFirst.mockResolvedValue(null);
    h.linkedFindMany.mockResolvedValue(
      IMAP_PRESET_KEYS.map((provider, index) => ({
        id: `acc-${index}`,
        email: `me${index}@example.com`,
        provider,
        needsReconnect: provider === "YAHOO",
        lastSyncedAt: null,
        syncErrorCode: provider === "YAHOO" ? "auth" : null,
        syncErrorAt: null,
      })),
    );
    const { accounts } = await listAccountHealth("u1");
    expect(accounts.map((account) => account.provider)).toEqual([...IMAP_PRESET_KEYS]);
    expect(accounts.find((account) => account.provider === "YAHOO")).toMatchObject({
      status: "reconnect",
      action: "reconnect",
    });
  });

  it("the reconnect alert names each preset's product", () => {
    expect(IMAP_PRESET_KEYS.map((key) => reconnectProviderLabel(key))).toEqual([
      "Daum Mail",
      "Kakao Mail",
      "Yahoo Mail",
      "AOL Mail",
      "Fastmail",
      "Zoho Mail",
      "Zoho Mail",
    ]);
  });
});
