import { beforeEach, describe, expect, it, vi } from "vitest";

interface MemoryRow {
  userId: string;
  type: string;
  key: string;
  content: string;
}

const memoryStore = new Map<string, MemoryRow>();
const memoryKey = (userId: string, type: string, key: string) => `${userId}::${type}::${key}`;

vi.mock("../db.js", () => ({
  prisma: {
    memory: {
      findUnique: vi.fn(async (args: unknown) => {
        const a = args as {
          where: { userId_type_key: { userId: string; type: string; key: string } };
        };
        const k = a.where.userId_type_key;
        return memoryStore.get(memoryKey(k.userId, k.type, k.key)) ?? null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        const a = args as {
          where: { userId_type_key: { userId: string; type: string; key: string } };
          create: MemoryRow;
          update: { content: string };
        };
        const k = a.where.userId_type_key;
        const id = memoryKey(k.userId, k.type, k.key);
        const existing = memoryStore.get(id);
        const row: MemoryRow = existing
          ? { ...existing, content: a.update.content }
          : { ...a.create };
        memoryStore.set(id, row);
        return { id, ...row };
      }),
    },
  },
}));

// memory.ts imports prisma via a typed alias; mock the helper directly so the
// remember() call path is exercised without re-implementing the upsert wiring.
vi.mock("../memory.js", () => ({
  remember: vi.fn(async (userId: string, type: string, key: string, content: string) => {
    const id = memoryKey(userId, type, key);
    memoryStore.set(id, { userId, type, key, content });
    return JSON.stringify({ success: true });
  }),
}));

beforeEach(() => {
  memoryStore.clear();
});

describe("isValidE164", () => {
  it("accepts E.164 numbers across common country codes", async () => {
    const { isValidE164 } = await import("../notify/sms-phone.js");
    expect(isValidE164("+821012345678")).toBe(true);
    expect(isValidE164("+14155552671")).toBe(true);
    expect(isValidE164("+441632960961")).toBe(true);
  });

  it("rejects malformed input (missing +, letters, too short, leading 0)", async () => {
    const { isValidE164 } = await import("../notify/sms-phone.js");
    expect(isValidE164("821012345678")).toBe(false);
    expect(isValidE164("+0123456789")).toBe(false); // CC can't start with 0
    expect(isValidE164("+12")).toBe(false); // too short
    expect(isValidE164("+12345678901234567")).toBe(false); // too long (16+ digits)
    expect(isValidE164("+1-415-555-2671")).toBe(false); // dashes
    expect(isValidE164("not-a-phone")).toBe(false);
    expect(isValidE164("")).toBe(false);
  });
});

describe("setPhoneNumber / getPhoneNumber round-trip", () => {
  it("stores a valid number and reads it back verbatim", async () => {
    const { getPhoneNumber, setPhoneNumber } = await import("../notify/sms-phone.js");
    await setPhoneNumber("user-1", "+821012345678");
    expect(await getPhoneNumber("user-1")).toBe("+821012345678");
  });

  it("trims whitespace before validating + storing", async () => {
    const { getPhoneNumber, setPhoneNumber } = await import("../notify/sms-phone.js");
    await setPhoneNumber("user-2", "  +14155552671  ");
    expect(await getPhoneNumber("user-2")).toBe("+14155552671");
  });

  it("returns null when no phone is stored", async () => {
    const { getPhoneNumber } = await import("../notify/sms-phone.js");
    expect(await getPhoneNumber("user-ghost")).toBeNull();
  });

  it("throws InvalidPhoneNumberError for malformed input", async () => {
    const { InvalidPhoneNumberError, setPhoneNumber } = await import("../notify/sms-phone.js");
    await expect(setPhoneNumber("user-3", "010-1234-5678")).rejects.toBeInstanceOf(
      InvalidPhoneNumberError,
    );
  });

  it("keeps phone numbers scoped per user", async () => {
    const { getPhoneNumber, setPhoneNumber } = await import("../notify/sms-phone.js");
    await setPhoneNumber("user-a", "+821011111111");
    await setPhoneNumber("user-b", "+821022222222");
    expect(await getPhoneNumber("user-a")).toBe("+821011111111");
    expect(await getPhoneNumber("user-b")).toBe("+821022222222");
  });
});
