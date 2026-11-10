/**
 * The Anthropic client authenticates by apiKey ONLY. The SDK otherwise reads
 * ANTHROPIC_AUTH_TOKEN from the environment, so a playground visitor's client
 * would carry a server bearer token next to the visitor's own key.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "../providers/anthropic-native.js";

describe("createAnthropicClient auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ignores ANTHROPIC_AUTH_TOKEN from the environment", () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "server-bearer-token");
    const client = createAnthropicClient("sk-ant-visitor-placeholder", 1000, null, 0);
    expect(client.authToken).toBeNull();
    expect(client.apiKey).toBe("sk-ant-visitor-placeholder");
    expect(client.maxRetries).toBe(0);
  });

  it("names the workspace only when one is passed", () => {
    const client = createAnthropicClient("sk-ant-visitor-placeholder", 1000, null);
    // biome-ignore lint/suspicious/noExplicitAny: reading the SDK's private default headers
    expect((client as any)._options.defaultHeaders?.["anthropic-workspace-id"]).toBeUndefined();
  });
});
