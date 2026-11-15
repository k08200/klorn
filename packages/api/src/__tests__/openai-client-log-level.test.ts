/**
 * The SDK clients log at "warn", whatever OPENAI_LOG / ANTHROPIC_LOG say.
 *
 * Given no `logLevel`, the OpenAI and Anthropic SDKs read it from the
 * environment and log through console. openai@7.55 at "debug" summarizes JSON
 * request and response bodies as a length, but logs a non-JSON error body
 * verbatim, and an OpenAI-compatible server (the self-host endpoint, the
 * embeddings endpoint) can answer a rejected request with a plain-text error
 * that quotes its input: someone's mail. createAnthropicClient pinned "warn";
 * the three OpenAI clients (embeddings, self-host compat, playground BYOK) did
 * not, until createOpenAIClient.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "../providers/anthropic-native.js";
import { createOpenAIClient } from "../providers/openai-client.js";
import { callText, LLM_CANARY } from "./helpers/canary.js";

const CONSOLE_METHODS = ["debug", "info", "log", "warn", "error"] as const;

/** A plain-text 400 that quotes the input, as a proxy or local server may answer. */
function textErrorQuotingInput(): Response {
  return new Response(`input rejected: ${LLM_CANARY} the body of someone's mail`, {
    status: 400,
    headers: { "content-type": "text/plain" },
  });
}

function embeddingResponse(): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: "nomic-embed-text",
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let spies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  vi.stubEnv("OPENAI_LOG", "debug");
  vi.stubEnv("ANTHROPIC_LOG", "debug");
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const consoleText = () => spies.map((spy) => callText(spy)).join("\n");

describe("the premise", () => {
  it("an unpinned OpenAI client takes OPENAI_LOG=debug and logs a text error body verbatim", async () => {
    // If the SDK stopped reading the env or logging that body, the tests
    // below would pass vacuously.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => textErrorQuotingInput()),
    );
    const client = new OpenAI({ apiKey: "local", baseURL: "http://127.0.0.1:11434/v1" });
    expect(client.logLevel).toBe("debug");

    await expect(
      client.embeddings.create({ model: "nomic-embed-text", input: ["x"] }),
    ).rejects.toThrow();

    expect(callText(spies[0] as ReturnType<typeof vi.spyOn>)).toContain(LLM_CANARY);
  });
});

describe("createOpenAIClient", () => {
  it("pins the log level to warn under OPENAI_LOG=debug", () => {
    const client = createOpenAIClient({
      apiKey: "local",
      baseURL: "http://127.0.0.1:11434/v1",
      timeout: 1000,
    });
    expect(client.logLevel).toBe("warn");
  });

  it("keeps the options it is given", () => {
    const client = createOpenAIClient({
      apiKey: "sk-test-placeholder",
      baseURL: "https://api.openai.com/v1",
      timeout: 1234,
      maxRetries: 0,
    });
    expect(client.baseURL).toBe("https://api.openai.com/v1");
    expect(client.timeout).toBe(1234);
    expect(client.maxRetries).toBe(0);
  });
});

describe("the clients Klorn builds", () => {
  it("embeddings: an error quoting the mail never reaches the console under OPENAI_LOG=debug", async () => {
    vi.stubEnv("EMBEDDING_MODEL", "nomic-embed-text");
    const fetch = vi.fn(async () => textErrorQuotingInput());
    vi.stubGlobal("fetch", fetch);
    vi.resetModules();
    const { embedTexts } = await import("../embedding.js");

    const vectors = await embedTexts(["the body of someone's mail"]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vectors).toEqual([null]);
    expect(consoleText()).not.toContain(LLM_CANARY);
  });

  it("embeddings: a healthy call still returns its vectors", async () => {
    vi.stubEnv("EMBEDDING_MODEL", "nomic-embed-text");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => embeddingResponse()),
    );
    vi.resetModules();
    const { embedTexts } = await import("../embedding.js");

    expect(await embedTexts(["hello"])).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("the self-host compat provider and the playground OpenAI provider log at warn", async () => {
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "http://127.0.0.1:11434/v1");
    vi.resetModules();
    const { getProvider, getProviderChain } = await import("../providers/index.js");

    const compat = getProvider("openai-compat");
    const visitor = getProviderChain({
      openAiApiKey: "sk-test-placeholder",
      playgroundOnly: true,
    })[0];

    expect(compat?.name).toBe("openai-compat");
    expect((compat?.client as OpenAI | undefined)?.logLevel).toBe("warn");
    expect(visitor?.name).toBe("openai");
    expect((visitor?.client as OpenAI | undefined)?.logLevel).toBe("warn");
  });

  it("the Anthropic client logs at warn under ANTHROPIC_LOG=debug", () => {
    expect(createAnthropicClient("sk-ant-placeholder", 1000, null).logLevel).toBe("warn");
  });
});

describe("no OpenAI client is built around the factory", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const FACTORY = "providers/openai-client.ts";
  const CONSTRUCTION = /new\s+(?:OpenAI|OpenAISDK|AzureOpenAI)\s*\(/;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      if (entry === "__tests__" || entry === "node_modules") return [];
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sources(full);
      return entry.endsWith(".ts") && !entry.endsWith(".d.ts") ? [full] : [];
    });
  }

  it("constructs the SDK only in providers/openai-client.ts", () => {
    const offenders = sources(srcDir)
      .map((full) => relative(srcDir, full).split("\\").join("/"))
      .filter((file) => file !== FACTORY)
      .filter((file) => CONSTRUCTION.test(readFileSync(join(srcDir, file), "utf8")));
    expect(offenders).toEqual([]);
    expect(CONSTRUCTION.test(readFileSync(join(srcDir, FACTORY), "utf8"))).toBe(true);
  });
});
