/**
 * One urgent mail rings once. Production, 2026-11-11: a PUSH mail rang
 * "Urgent email" (firewall, interrupt bucket) and 13 s later the agent's
 * notify_user rang "[Klorn] Unverified quote request with a deadline"
 * (ambient) for the same mail, because the agent deduped only against its own
 * notifications. A notify_user about a context mail that already rang as
 * urgent mail now writes no bell row and rings nothing; everything else rings
 * as before (ambient, autonomous-agent-push-bucket.test.ts).
 *
 * Drives the real runAgentForUser loop with the model's reply faked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  sendPushNotification: vi.fn(async () => ({ status: "sent" })),
  notificationFindMany: vi.fn(),
  notificationCreate: vi.fn(),
  context: {
    text: "",
    emails: [] as Array<{ id: string; gmailId: string; createdAt: Date }>,
  },
}));

vi.mock("../db.js", () => {
  // Every model answers like an empty database; create echoes a row back.
  const model = () =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          vi.fn(async (args?: { data?: Record<string, unknown> }) => {
            if (method === "findMany" || method === "groupBy") return [];
            if (method === "count") return 0;
            if (method === "create" || method === "upsert" || method === "update") {
              return { id: "row-1", createdAt: new Date(), ...(args?.data ?? {}) };
            }
            if (method === "updateMany" || method === "deleteMany" || method === "createMany") {
              return { count: 0 };
            }
            return null;
          }),
      },
    );
  const models = new Map<string, unknown>();
  models.set(
    "notification",
    new Proxy(
      {},
      {
        get: (_target, method: string) => {
          if (method === "findMany") return mocks.notificationFindMany;
          if (method === "create") return mocks.notificationCreate;
          if (method === "count") return vi.fn(async () => 0);
          return vi.fn(async () => null);
        },
      },
    ),
  );
  const client = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name.startsWith("$")) return vi.fn(async () => []);
        if (!models.has(name)) models.set(name, model());
        return models.get(name);
      },
    },
  );
  return { prisma: client, db: client };
});
vi.mock("../llm/openai.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/openai.js")>()),
  createCompletion: mocks.createCompletion,
}));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => ({ userModel: null })),
}));
vi.mock("../agentcore/agent-context.js", () => ({
  gatherUserContext: vi.fn(async () => mocks.context.text),
  gatherAgentContext: vi.fn(async () => ({
    text: mocks.context.text,
    emails: mocks.context.emails,
  })),
}));
vi.mock("../billing/token-usage.js", () => ({ trackTokenUsage: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: mocks.sendPushNotification }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { runAgentForUser } from "../agentcore/autonomous-agent.js";

const RECEIVED = new Date();
const QUOTE = { id: "04ee4a4b-quote", gmailId: "g-quote", createdAt: RECEIVED };
const LUNCH = { id: "lunch-mail", gmailId: "g-lunch", createdAt: RECEIVED };

function contextWith(emails: Array<{ id: string; gmailId: string; createdAt: Date }>) {
  const lines = emails.map(
    (e, i) => `### Email #${i + 1} (received: 11:05) 📩 UNREAD\n  Subject: mail ${e.gmailId}`,
  );
  return {
    text: `## Open Tasks\nNone\n\n## Upcoming Calendar\nNone\n\n## Recent Emails (${emails.length})\n${lines.join("\n\n")}`,
    emails,
  };
}

/** The firewall's bell row for a mail it rang as urgent (firewall-push.ts firewallBellRow). */
function urgentBellRow(email: { id: string; gmailId: string }) {
  return {
    sourceEmailId: email.id,
    message: `Kim: 오늘 17시까지 회신 부탁드립니다 [${email.gmailId}]`,
    createdAt: new Date(),
  };
}

function notifyUserReply(args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "notify_user",
                arguments: JSON.stringify({ priority: "high", ...args }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const DONE = { choices: [{ message: { role: "assistant", content: "Done." } }], usage: {} };

const QUOTE_NOTIFY = {
  title: "Unverified quote request with a deadline",
  message: "Kim asks for the final quote confirmation by 17:00 today.",
  category: "email",
};

/** Bell rows the agent wrote (its title carries the [Klorn] prefix). */
function agentBellRows(): unknown[] {
  return mocks.notificationCreate.mock.calls.filter((call) => {
    const data = (call[0] as { data?: { title?: string } }).data;
    return typeof data?.title === "string" && data.title.startsWith("[Klorn]");
  });
}

/** What the loop told the model about its notify_user call. */
function toolResultFor(callId: string): string | undefined {
  const second = mocks.createCompletion.mock.calls[1]?.[0] as
    | { messages: Array<{ role: string; content?: string; tool_call_id?: string }> }
    | undefined;
  return second?.messages.find((m) => m.role === "tool" && m.tool_call_id === callId)?.content;
}

/** urgent rows answer only the urgent-mail title query; the agent's own dedupe reads none. */
function urgentRowsAre(rows: unknown[]) {
  mocks.notificationFindMany.mockImplementation(async (args?: { where?: { title?: unknown } }) =>
    args?.where?.title && typeof args.where.title === "object" && "in" in args.where.title
      ? rows
      : [],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.notificationCreate.mockImplementation(async (args?: { data?: object }) => ({
    id: "row-1",
    createdAt: new Date(),
    ...(args?.data ?? {}),
  }));
  urgentRowsAre([]);
});

describe("agent notify_user vs a mail that already rang as urgent", () => {
  it("does not ring or write a bell row for the mail its emailRef names when that mail already rang", async () => {
    mocks.context = contextWith([QUOTE, LUNCH]);
    urgentRowsAre([urgentBellRow(QUOTE)]);
    mocks.createCompletion
      .mockResolvedValueOnce(notifyUserReply({ ...QUOTE_NOTIFY, emailRef: 1 }))
      .mockResolvedValueOnce(DONE);

    await runAgentForUser("user-ref", "SUGGEST");

    expect(mocks.sendPushNotification).not.toHaveBeenCalled();
    expect(agentBellRows()).toHaveLength(0);
    expect(toolResultFor("call-1")).toContain('"skipped":true');
  });

  it("prod shape: an email notification without a ref, and the only context mail already rang → no second ring", async () => {
    mocks.context = contextWith([QUOTE]);
    urgentRowsAre([urgentBellRow(QUOTE)]);
    mocks.createCompletion
      .mockResolvedValueOnce(notifyUserReply(QUOTE_NOTIFY))
      .mockResolvedValueOnce(DONE);

    await runAgentForUser("user-noref", "SUGGEST");

    expect(mocks.sendPushNotification).not.toHaveBeenCalled();
    expect(agentBellRows()).toHaveLength(0);
  });

  it("still rings, ambient, for an unrelated notification while an urgent mail is in context", async () => {
    mocks.context = contextWith([QUOTE]);
    urgentRowsAre([urgentBellRow(QUOTE)]);
    mocks.createCompletion
      .mockResolvedValueOnce(
        notifyUserReply({
          title: "Board call starts in 5 minutes",
          message: "Join link: https://meet.example/abc",
          category: "calendar",
        }),
      )
      .mockResolvedValueOnce(DONE);

    await runAgentForUser("user-calendar", "SUGGEST");

    expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1);
    const [, payload, , options] = mocks.sendPushNotification.mock.calls[0] as unknown as [
      string,
      { title: string },
      string,
      unknown,
    ];
    expect(payload.title).toContain("Board call starts in 5 minutes");
    expect(options).toEqual({ bucket: "ambient" });
    expect(agentBellRows()).toHaveLength(1);
  });

  it("still rings for a context mail that did not ring, even when another one did", async () => {
    mocks.context = contextWith([QUOTE, LUNCH]);
    urgentRowsAre([urgentBellRow(QUOTE)]);
    mocks.createCompletion
      .mockResolvedValueOnce(
        notifyUserReply({
          title: "Lunch moved to 12:30",
          message: "Jin moved today's lunch to 12:30.",
          category: "email",
          emailRef: 2,
        }),
      )
      .mockResolvedValueOnce(DONE);

    await runAgentForUser("user-other-mail", "SUGGEST");

    expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1);
    expect(agentBellRows()).toHaveLength(1);
  });

  it("keeps ringing when an email notification has no ref and some context mail has not rung (cannot tell which mail)", async () => {
    mocks.context = contextWith([QUOTE, LUNCH]);
    urgentRowsAre([urgentBellRow(QUOTE)]);
    mocks.createCompletion
      .mockResolvedValueOnce(notifyUserReply(QUOTE_NOTIFY))
      .mockResolvedValueOnce(DONE);

    await runAgentForUser("user-ambiguous", "SUGGEST");

    expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it("rings as before when the urgent-row lookup fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.context = contextWith([QUOTE]);
    mocks.notificationFindMany.mockImplementation(
      async (args?: { where?: { title?: unknown } }) => {
        if (args?.where?.title && typeof args.where.title === "object") {
          throw new Error("db down");
        }
        return [];
      },
    );
    mocks.createCompletion
      .mockResolvedValueOnce(notifyUserReply({ ...QUOTE_NOTIFY, emailRef: 1 }))
      .mockResolvedValueOnce(DONE);

    await runAgentForUser("user-db-down", "SUGGEST");

    expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1);
  });
});
