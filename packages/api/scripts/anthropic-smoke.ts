/**
 * Live smoke of the native Anthropic adapter against the real API.
 *
 * Synthetic prompts only — no user data. Prints a PASS/FAIL line per check
 * (finish reasons, short contents, usage; never the key) and exits 1 if any
 * required check fails. Checks the behaviours unit tests can only assume:
 *  - JSON mode via the forced tool on Haiku 5.5, and via tool_choice auto on
 *    a model that rejects forced tool use (Sonnet 5.5);
 *  - a system prompt under the 512-token cache minimum carrying cache_control
 *    is accepted (not a 400);
 *  - a long stable system prompt is read from cache on the second call;
 *  - the chat tool loop round-trips (thinking blocks replayed);
 *  - a small max_tokens still yields text (thinking headroom).
 *
 * Usage: ANTHROPIC_API_KEY=… npx tsx scripts/anthropic-smoke.ts
 */

import { ANTHROPIC_CONTENT } from "../src/providers/anthropic-native.js";
import { getProvider } from "../src/providers/index.js";

type Completion = {
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    } & Record<symbol, unknown>;
  }>;
  usage?: { prompt_tokens_details?: { cached_tokens?: number } };
};

const provider = getProvider("anthropic");
if (!provider) {
  console.error("anthropic provider not configured (ANTHROPIC_API_KEY unset)");
  process.exit(1);
}
const HAIKU = "claude-haiku-5-5";
const NO_FORCED_TOOL_MODEL = "claude-sonnet-5-5";
const failures: string[] = [];

async function call(label: string, model: string, params: object): Promise<Completion | null> {
  const started = Date.now();
  try {
    const res = (await provider?.call(
      { model, ...params } as never,
      model,
    )) as unknown as Completion;
    const msg = res.choices[0].message;
    console.log(
      `[${label}] ${model} ${Date.now() - started}ms finish=${res.choices[0].finish_reason}`,
      JSON.stringify({
        content: typeof msg.content === "string" ? msg.content.slice(0, 160) : msg.content,
        tool_calls: msg.tool_calls?.map((t) => `${t.function.name}(${t.function.arguments})`),
        rawBlocks: Array.isArray(msg[ANTHROPIC_CONTENT])
          ? (msg[ANTHROPIC_CONTENT] as Array<{ type: string }>).map((b) => b.type)
          : undefined,
        usage: res.usage,
      }),
    );
    return res;
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.log(`[${label}] ${model} ERROR ${e.status ?? ""} ${String(e.message).slice(0, 300)}`);
    return null;
  }
}

function check(label: string, ok: boolean, required = true): void {
  console.log(`${ok ? "PASS" : required ? "FAIL" : "INFO"} ${label}`);
  if (!ok && required) failures.push(label);
}

function isJsonObjectWithKeys(text: string | null | undefined): boolean {
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

const scorePrompt = {
  max_tokens: 1024,
  temperature: 0,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: "You are a strict JSON scorer. Respond with valid JSON only." },
    {
      role: "user",
      content:
        'Score this email. Respond with JSON only: {"confidence":0.0,"urgency":0.0,"reason":"short phrase"}\nfrom: ops@acme.test\nsubject: Production database is down, customers cannot log in\nsnippet: Need your approval to fail over in the next 30 minutes.',
    },
  ],
};

// 1. JSON mode: forced tool on Haiku, tool_choice auto on Sonnet 5.5. Both
//    system prompts are far under 512 tokens and still carry cache_control.
const forced = await call("json-forced-tool", HAIKU, scorePrompt);
check(
  "JSON via forced tool (Haiku 5.5), short cached system accepted",
  isJsonObjectWithKeys(forced?.choices[0].message.content),
);
const auto = await call("json-auto-tool", NO_FORCED_TOOL_MODEL, scorePrompt);
check(
  "JSON via tool_choice auto (Sonnet 5.5 rejects forced tools)",
  isJsonObjectWithKeys(auto?.choices[0].message.content),
);

// 2. Long stable system prompt twice — the second call should read from cache.
const longSystem = [
  "You analyse one email and return a JSON summary.",
  ...Array.from(
    { length: 90 },
    (_, i) =>
      `Rule ${i + 1}: when the email mentions topic number ${i + 1}, describe it neutrally, keep names, never invent facts, and keep the summary under forty words.`,
  ),
].join("\n");
let secondPass: Completion | null = null;
for (const pass of [1, 2]) {
  secondPass = await call(`long-system-pass-${pass}`, HAIKU, {
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: longSystem },
      {
        role: "user",
        content: `Email ${pass}: "Lunch moved to 1pm on Friday." Return {"summary":"..."}`,
      },
    ],
  });
}
check(
  "prompt cache read on the second call with the same system prompt",
  (secondPass?.usage?.prompt_tokens_details?.cached_tokens ?? 0) > 0,
);

// 3. Tool loop with tool_choice auto (thinking may run before the call).
const tools = [
  {
    type: "function",
    function: {
      name: "get_calendar",
      description: "Get the user's calendar events for a day",
      parameters: {
        type: "object",
        properties: { day: { type: "string", description: "today or YYYY-MM-DD" } },
        required: ["day"],
      },
    },
  },
];
const base = [
  { role: "system", content: "You are a calendar assistant. Use the tool to answer." },
  { role: "user", content: "What meetings do I have today?" },
];
const first = await call("tool-call", HAIKU, {
  max_tokens: 1000,
  temperature: 0.3,
  tools,
  tool_choice: "auto",
  messages: base,
});
const assistant = first?.choices[0].message;
check("tool call returned", (assistant?.tool_calls?.length ?? 0) > 0);
if (assistant?.tool_calls?.length) {
  const results = assistant.tool_calls.map((t) => ({
    role: "tool",
    tool_call_id: t.id,
    content: "10:00 Standup; 14:00 Investor call",
  }));
  const replay = await call("tool-result-with-raw-blocks", HAIKU, {
    max_tokens: 1000,
    tools,
    tool_choice: "auto",
    messages: [...base, assistant, ...results],
  });
  check(
    "tool loop completes with the original blocks replayed",
    Boolean(replay?.choices[0].message.content),
  );
  // Rebuilt from the OpenAI fields only (thinking blocks dropped): tells us
  // whether the replay is required or merely preferred. Informational.
  const stripped = {
    role: "assistant",
    content: assistant.content,
    tool_calls: assistant.tool_calls,
  };
  const rebuilt = await call("tool-result-without-raw-blocks", HAIKU, {
    max_tokens: 1000,
    tools,
    tool_choice: "auto",
    messages: [...base, stripped, ...results],
  });
  check(
    "tool loop also completes WITHOUT replayed blocks",
    Boolean(rebuilt?.choices[0].message.content),
    false,
  );
}

// 4. Plain text call with a small cap (thinking headroom).
const plain = await call("plain-text-small-cap", HAIKU, {
  max_tokens: 120,
  messages: [{ role: "user", content: "In one sentence: why do inbox triage tools exist?" }],
});
check(
  "plain text with a small max_tokens still returns text",
  Boolean(plain?.choices[0].message.content),
);

console.log(failures.length === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
