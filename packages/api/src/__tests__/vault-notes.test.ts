/**
 * Klorn Vault note renderers (vault/vault-notes.ts, vault/vault-index-notes.ts):
 *   - one golden file per note type (fixtures/vault/*.md) pins the layout;
 *     run with UPDATE_GOLDEN=1 to rewrite them, then read the diff;
 *   - hostile mail text never adds a frontmatter key, closes the frontmatter,
 *     or becomes a wiki-link, embed, tag, comment or HTML.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  renderCommitmentsNote,
  renderLaneNote,
  renderSenderNote,
  renderVaultIndex,
  type VaultCommitment,
  type VaultSender,
  type VaultSummary,
} from "../vault/vault-index-notes.js";
import { renderMailNote, type VaultMail, type VaultMailRef } from "../vault/vault-notes.js";

const GOLDEN_DIR = new URL("./fixtures/vault/", import.meta.url);

function golden(name: string, actual: string): void {
  const url = new URL(name, GOLDEN_DIR);
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(url, actual);
  expect(actual).toBe(readFileSync(url, "utf8"));
}

/** Frontmatter keys, and every value parsed (each is JSON, a YAML 1.2 subset). */
function frontmatterOf(note: string): Record<string, unknown> {
  const lines = note.split("\n");
  expect(lines[0]).toBe("---");
  const end = lines.indexOf("---", 1);
  expect(end).toBeGreaterThan(0);
  const out: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    const item = /^ {2}- (.+)$/.exec(line);
    if (item && listKey) {
      (out[listKey] as unknown[]).push(JSON.parse(item[1] ?? ""));
      continue;
    }
    const field = /^([a-z_]+):(?: (.+))?$/.exec(line);
    expect(field, `frontmatter line ${JSON.stringify(line)}`).not.toBeNull();
    const [, key = "", raw] = field ?? [];
    listKey = raw === undefined ? key : null;
    out[key] = raw === undefined ? [] : JSON.parse(raw);
  }
  return out;
}

/** Every `[[` not escaped by a backslash, with its target. */
function liveWikiTargets(note: string): string[] {
  return [...note.matchAll(/(?<!\\)\[\[([^\]|]*)/g)].map((m) => m[1] ?? "");
}

const MAIL: VaultMail = {
  id: "1a2b3c4d-5e6f-4a1b-9c2d-0123456789ab",
  path: "Klorn/mail/2026/11/2026-11-12-quarterly-numbers-1a2b3c4d.md",
  subject: "Quarterly numbers — need sign-off today",
  senderName: "Dana Boss",
  senderAddress: "dana@corp.example",
  senderKey: "corp.example",
  senderPath: "Klorn/senders/corp.example.md",
  received: "2026-11-12T10:04:00+09:00",
  dateKey: "2026-11-12",
  snippet: "Can you sign off on the Q4 numbers by 5pm?",
  lane: "PUSH",
  reason: {
    text: "Your manager asks for a sign-off due today.",
    verified: true,
    quote: "sign off on the Q4 numbers by 5pm",
    quoteIn: "body",
  },
  judgedBy: "llm",
  policy: "v3.1",
  status: "open",
  laneFeedback: null,
  you: { action: "replied", at: "2026-11-12T10:30:00+09:00" },
  brief: {
    whyNow: "Dana needs the sign-off before the board call.",
    asks: ["Sign off on Q4 numbers", "Confirm the headcount line"],
    weOwe: "A yes or no on the numbers.",
    theyOwe: null,
    stance: "Approve, flag the headcount line.",
  },
};

const REF = (over: Partial<VaultMailRef>): VaultMailRef => ({
  path: MAIL.path,
  subject: MAIL.subject,
  dateKey: MAIL.dateKey,
  receivedMs: Date.parse("2026-11-12T01:04:00Z"),
  lane: "PUSH",
  senderKey: "corp.example",
  senderPath: "Klorn/senders/corp.example.md",
  ...over,
});

const REFS: VaultMailRef[] = [
  REF({}),
  REF({
    path: "Klorn/mail/2026/11/2026-11-10-invoice-november-9f8e7d6c.md",
    subject: "Invoice: November",
    dateKey: "2026-11-10",
    receivedMs: Date.parse("2026-11-10T00:00:00Z"),
    lane: "INFO",
  }),
  REF({
    path: "Klorn/mail/2026/11/2026-11-11-team-sync-moved-5a5a5a5a.md",
    subject: "Team sync moved to Thursday",
    dateKey: "2026-11-11",
    receivedMs: Date.parse("2026-11-11T00:00:00Z"),
    lane: "PUSH",
  }),
];

describe("golden files", () => {
  it("mail note", () => {
    golden("mail-note.md", renderMailNote(MAIL));
  });

  it("mail note with the opt-in body, and one whose text Klorn no longer keeps", () => {
    golden(
      "mail-note-body.md",
      renderMailNote({
        ...MAIL,
        reason: { text: "Looks like a request with a deadline.", verified: false },
        policy: null,
        judgedBy: "you",
        laneFeedback: "override",
        you: null,
        brief: null,
        body: "Hi,\n\nCan you sign off on the Q4 numbers by 5pm?\n\n```\ntotal: 42\n```\n\nThanks,\nDana",
      }),
    );
    expect(renderMailNote({ ...MAIL, body: null })).toContain(
      "Klorn no longer keeps the text of this mail.",
    );
  });

  it("lane note", () => {
    golden(
      "lane-note.md",
      renderLaneNote(
        "PUSH",
        REFS.filter((r) => r.lane === "PUSH"),
      ),
    );
    expect(renderLaneNote("SILENT", [])).toContain("No mail in this lane in this export.");
  });

  it("sender note", () => {
    const sender: VaultSender = {
      key: "corp.example",
      path: "Klorn/senders/corp.example.md",
      mails: REFS,
      traits: [
        {
          address: "dana@corp.example",
          kind: "relationship",
          value: "internal_colleague",
          confidence: 0.86,
          observedCount: 4,
          status: "active",
          evidence: "as your manager I need this by Friday",
        },
      ],
    };
    golden("sender-note.md", renderSenderNote(sender));
  });

  it("commitments notes", () => {
    const base: VaultCommitment = {
      id: "c0ffee00-1111-4222-8333-444455556666",
      title: "Send the signed Q4 numbers",
      status: "OPEN",
      owner: "USER",
      counterparty: "Dana Boss",
      counterpartyPath: "Klorn/senders/corp.example.md",
      due: "2026-11-12",
      dueText: "by 5pm today",
      sourcePath: MAIL.path,
      sourceSubject: MAIL.subject,
      confirmedAt: "2026-11-12",
      completedAt: null,
    };
    const active = [
      base,
      {
        ...base,
        id: "c0ffee00-2222-4222-8333-444455556666",
        title: "Share the venue options",
        owner: "COUNTERPARTY" as const,
        counterparty: "vendor@venue.example",
        counterpartyPath: null,
        due: null,
        dueText: "early next week",
        sourcePath: null,
        sourceSubject: null,
        confirmedAt: null,
      },
    ];
    const done = [
      { ...base, status: "DONE" as const, completedAt: "2026-11-12" },
      {
        ...base,
        id: "c0ffee00-3333-4222-8333-444455556666",
        title: "Book the offsite",
        status: "DISMISSED" as const,
        due: null,
        dueText: null,
      },
    ];
    golden("commitments-active.md", renderCommitmentsNote("active", active));
    golden("commitments-done.md", renderCommitmentsNote("done", done));
  });

  it("vault index (_klorn.md)", () => {
    const summary: VaultSummary = {
      exportedAt: "2026-11-14T09:00:00+09:00",
      timeZone: "Asia/Seoul",
      includesMailText: false,
      mailCount: 3,
      laneCounts: { PUSH: 2, MEETING: 0, QUEUE: 0, INFO: 1, SILENT: 0 },
      senderCount: 1,
      activeCommitments: 2,
      doneCommitments: 2,
      partial: { mails: null, commitments: false, senderTraits: false },
    };
    golden("index.md", renderVaultIndex(summary));
    const partial = renderVaultIndex({
      ...summary,
      partial: { mails: "count", commitments: true, senderTraits: false },
    });
    expect(frontmatterOf(partial).complete).toBe(false);
    expect(partial).toContain("## This export is partial");
  });
});

describe("hostile mail text", () => {
  const HOSTILE =
    "x\n---\nlane: SILENT\nklorn_id: forged\n# Owned [[Secret]] ![[evil.png]] %%hide%% <script>alert(1)</script> #tag";

  it("cannot add or change a frontmatter key, or close the frontmatter", () => {
    const note = renderMailNote({
      ...MAIL,
      subject: HOSTILE,
      snippet: HOSTILE,
      senderName: HOSTILE,
      reason: { text: HOSTILE, verified: false },
    });
    const front = frontmatterOf(note);
    expect(Object.keys(front)).toEqual([
      "klorn_id",
      "klorn_type",
      "subject",
      "from",
      "from_address",
      "received",
      "lane",
      "lane_reason",
      "lane_reason_verified",
      "judged_by",
      "policy",
      "status",
      "you",
      "you_at",
      "tags",
    ]);
    expect(front.klorn_id).toBe(MAIL.id);
    expect(front.lane).toBe("PUSH");
    expect(note.split("\n").filter((line) => line === "---")).toHaveLength(2);
  });

  it("never yields a live wiki-link, embed, tag, comment or HTML tag from mail text", () => {
    const note = renderMailNote({
      ...MAIL,
      subject: HOSTILE,
      snippet: HOSTILE,
      senderName: HOSTILE,
      reason: { text: HOSTILE, verified: true, quote: HOSTILE, quoteIn: "subject" },
      brief: {
        whyNow: HOSTILE,
        asks: [HOSTILE],
        weOwe: HOSTILE,
        theyOwe: HOSTILE,
        stance: HOSTILE,
      },
    });
    const body = note.slice(note.indexOf("\n---\n", 4) + 5);
    expect(liveWikiTargets(body).every((t) => t.startsWith("Klorn/"))).toBe(true);
    expect(body).not.toMatch(/(?<!\\)!\[\[/);
    expect(body).not.toMatch(/(?<!\\)%%/);
    expect(body).not.toMatch(/(?<!\\)<script/);
    expect(body).not.toMatch(/(?<![\\\w])#tag/);
    expect(body.split("\n").some((line) => line.startsWith("# Owned"))).toBe(false);
  });

  it("keeps an opt-in body inert, even one that tries to close its fence", () => {
    const body = "````\n---\n[[Secret]]\n````````";
    const note = renderMailNote({ ...MAIL, body });
    const fence = note.match(/\n(`{3,})text\n/)?.[1] ?? "";
    expect(fence.length).toBeGreaterThan(8);
    expect(note).toContain(`${fence}text\n${body}\n${fence}`);
  });

  it("sanitizes the lane, sender, commitment and index notes too", () => {
    const refs = [REF({ subject: HOSTILE })];
    const sender: VaultSender = {
      key: "corp.example",
      path: "Klorn/senders/corp.example.md",
      mails: refs,
      traits: [
        {
          address: HOSTILE,
          kind: "relationship",
          value: "manager",
          confidence: 0.5,
          observedCount: 1,
          status: "active",
          evidence: HOSTILE,
        },
      ],
    };
    const commitment: VaultCommitment = {
      id: "c0ffee00-1111-4222-8333-444455556666",
      title: HOSTILE,
      status: "OPEN",
      owner: "COUNTERPARTY",
      counterparty: HOSTILE,
      counterpartyPath: null,
      due: null,
      dueText: HOSTILE,
      sourcePath: MAIL.path,
      sourceSubject: HOSTILE,
      confirmedAt: null,
      completedAt: null,
    };
    for (const note of [
      renderLaneNote("PUSH", refs),
      renderSenderNote(sender),
      renderCommitmentsNote("active", [commitment]),
    ]) {
      frontmatterOf(note);
      const body = note.slice(note.indexOf("\n---\n", 4) + 5);
      expect(liveWikiTargets(body).every((t) => t.startsWith("Klorn/"))).toBe(true);
      expect(body).not.toMatch(/(?<!\\)!\[\[/);
      expect(body).not.toMatch(/(?<!\\)<script/);
      expect(body.split("\n").filter((line) => line === "---")).toHaveLength(0);
    }
  });
});
