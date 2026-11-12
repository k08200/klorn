import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the completion suggestions (pim/commitment-completion.ts
// and migration 20261112000000_commitment_confirm_and_completion): a later reply
// in the promise's own thread stamps completionSuggestedAt — the user's own send
// for a promise the user owes, the counterparty writing again for theirs — and
// nothing else does: not Klorn's autonomous replies, not another account's mail
// in a thread with the same id, not another user's data. The row stays OPEN.
// Skipped unless KLORN_TEST_PG_URL points at a database with every migration
// applied.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { refreshCompletionSuggestions } from "../pim/commitment-completion.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
const HOUR = 3_600_000;
const T0 = new Date(Date.now() - 48 * HOUR);
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `commit-${randomUUID()}@test.local` } });
  createdUsers.push(user.id);
  return user.id;
}

async function newMail(
  userId: string,
  threadId: string,
  receivedAt: Date,
  from = "Sarah Kim <Sarah@Acme.example>",
): Promise<string> {
  const row = await prisma.emailMessage.create({
    data: {
      userId,
      gmailId: `g-${randomUUID()}`,
      threadId,
      from,
      to: "me@test.local",
      subject: "Deck",
      labels: ["INBOX"],
      receivedAt,
    },
  });
  return row.id;
}

async function newSend(userId: string, threadId: string, sentAt: Date, origin: string | null) {
  await prisma.sentMessage.create({
    data: {
      userId,
      gmailId: `s-${randomUUID()}`,
      threadId,
      to: "sarah@acme.example",
      subject: "Re: Deck",
      sentAt,
      inbox: "primary",
      origin,
    },
  });
}

async function newCommitment(
  userId: string,
  over: { owner: "USER" | "COUNTERPARTY"; threadId: string; sourceId: string },
): Promise<string> {
  const row = await prisma.commitment.create({
    data: {
      userId,
      title: "Send the deck",
      confidence: 0.45,
      sourceType: "EMAIL",
      counterpartyEmail: over.owner === "COUNTERPARTY" ? "Sarah Kim <Sarah@Acme.example>" : null,
      ...over,
    },
  });
  return row.id;
}

const stampOf = async (id: string) =>
  prisma.commitment.findUniqueOrThrow({
    where: { id },
    select: { status: true, completionSuggestedAt: true },
  });

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("refreshCompletionSuggestions (real Postgres)", () => {
  it("stamps likely done on the user's own later reply, not on Klorn's auto-reply", async () => {
    const userId = await newUser();
    const thread = `t-${randomUUID()}`;
    const source = await newMail(userId, thread, T0);
    const id = await newCommitment(userId, { owner: "USER", threadId: thread, sourceId: source });
    await newSend(userId, thread, at(1), "auto_reply");
    expect(await refreshCompletionSuggestions(userId)).toBe(0);

    await newSend(userId, thread, at(2), null);
    expect(await refreshCompletionSuggestions(userId)).toBe(1);
    expect(await stampOf(id)).toEqual({ status: "OPEN", completionSuggestedAt: at(2) });
    // Stamped once: a later read finds nothing new.
    expect(await refreshCompletionSuggestions(userId)).toBe(0);
  });

  it("stamps likely delivered when the counterparty writes again, by mailbox", async () => {
    const userId = await newUser();
    const thread = `t-${randomUUID()}`;
    const source = await newMail(userId, thread, T0);
    const id = await newCommitment(userId, {
      owner: "COUNTERPARTY",
      threadId: thread,
      sourceId: source,
    });
    await newMail(userId, thread, at(1), "Bob <bob@acme.example>");
    expect(await refreshCompletionSuggestions(userId)).toBe(0);

    await newMail(userId, thread, at(3), "sarah@acme.example");
    expect(await refreshCompletionSuggestions(userId)).toBe(1);
    expect(await stampOf(id)).toEqual({ status: "OPEN", completionSuggestedAt: at(3) });
  });

  it("never reads another user's thread with the same id", async () => {
    const userId = await newUser();
    const other = await newUser();
    const thread = `t-${randomUUID()}`;
    const source = await newMail(userId, thread, T0);
    const mine = await newCommitment(userId, { owner: "USER", threadId: thread, sourceId: source });
    const theirSource = await newMail(other, thread, T0);
    const theirs = await newCommitment(other, {
      owner: "COUNTERPARTY",
      threadId: thread,
      sourceId: theirSource,
    });
    await newSend(other, thread, at(1), null);
    await newMail(userId, thread, at(1), "sarah@acme.example");

    expect(await refreshCompletionSuggestions(userId)).toBe(0);
    expect(await refreshCompletionSuggestions(other)).toBe(0);
    expect((await stampOf(mine)).completionSuggestedAt).toBeNull();
    expect((await stampOf(theirs)).completionSuggestedAt).toBeNull();
  });

  it("leaves a dismissed row alone", async () => {
    const userId = await newUser();
    const thread = `t-${randomUUID()}`;
    const source = await newMail(userId, thread, T0);
    const id = await newCommitment(userId, { owner: "USER", threadId: thread, sourceId: source });
    await prisma.commitment.update({ where: { id }, data: { status: "DISMISSED" } });
    await newSend(userId, thread, at(1), null);

    expect(await refreshCompletionSuggestions(userId)).toBe(0);
    expect(await stampOf(id)).toEqual({ status: "DISMISSED", completionSuggestedAt: null });
  });
});
