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

  it("pins the SDK's OpenTelemetry tracing off, whatever the environment says", () => {
    // SDK >= 0.134 traces every call through the global tracer provider (Sentry
    // registers one), and ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE=content
    // would put prompts and completions — mail — on those spans.
    vi.stubEnv("ANTHROPIC_OPEN_TELEMETRY", "true");
    vi.stubEnv("ANTHROPIC_OPEN_TELEMETRY_PROPAGATION", "true");
    vi.stubEnv("ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE", "content");
    const client = createAnthropicClient("sk-ant-visitor-placeholder", 1000, null);
    expect(client.openTelemetry.traces.enabled).toBe(false);
    expect(client.openTelemetry.traces.contentMode).toBe("metadata_only");
    expect(client.openTelemetry.propagation).toBe(false);
  });

  it("names the workspace only when one is passed", () => {
    const client = createAnthropicClient("sk-ant-visitor-placeholder", 1000, null);
    // biome-ignore lint/suspicious/noExplicitAny: reading the SDK's private default headers
    expect((client as any)._options.defaultHeaders?.["anthropic-workspace-id"]).toBeUndefined();
  });
});
