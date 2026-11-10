/**
 * klornInboundConfig (config.ts): the inbound webhook's settings, read per
 * request (step E1b of docs/providers/unified-platform-plan.md). A value that is
 * set but unusable counts as missing, so the route answers 503 and names it.
 */

import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { klornInboundConfig } from "../config.js";

const KEYS = [
  "RESEND_INBOUND_WEBHOOK_SECRET",
  "RESEND_INBOUND_API_KEY",
  "KLORN_MAILBOX_DOMAIN",
  "KLORN_MAILBOX_FORWARD_TO",
] as const;
const saved = new Map<string, string | undefined>();
const strongSecret = (bytes = 24) => `whsec_${crypto.randomBytes(bytes).toString("base64")}`;

beforeEach(() => {
  for (const key of KEYS) saved.set(key, process.env[key]);
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = strongSecret();
  process.env.RESEND_INBOUND_API_KEY = "re_test";
  process.env.KLORN_MAILBOX_DOMAIN = "klorn.ai";
  process.env.KLORN_MAILBOX_FORWARD_TO = "support@example.com";
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function missing(): string[] {
  const config = klornInboundConfig();
  return config.ok ? [] : config.missing;
}

describe("the mailbox domain", () => {
  it("is lowercased", () => {
    process.env.KLORN_MAILBOX_DOMAIN = " KLORN.AI ";
    const config = klornInboundConfig();
    expect(config.ok && config.domain).toBe("klorn.ai");
  });

  it.each([
    "",
    "https://klorn.ai",
    "klorn.ai.",
    "@klorn.ai",
    "klorn",
    "klorn.ai/inbound",
    "klKrn.ai",
  ])("counts %j as missing", (value) => {
    process.env.KLORN_MAILBOX_DOMAIN = value;
    expect(missing()).toEqual(["KLORN_MAILBOX_DOMAIN"]);
  });
});

describe("the webhook secret", () => {
  it("accepts a whsec_ secret of at least 16 bytes", () => {
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = strongSecret(16);
    expect(klornInboundConfig().ok).toBe(true);
  });

  it.each([
    ["the bare prefix", "whsec_"],
    ["a short key", strongSecret(15)],
    ["no prefix", crypto.randomBytes(24).toString("base64")],
    ["characters outside base64", "whsec_not*base64*at*all*here*xx"],
    ["broken padding", `whsec_${crypto.randomBytes(24).toString("base64")}=`],
  ])("counts %s as missing", (_label, value) => {
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = value;
    expect(missing()).toEqual(["RESEND_INBOUND_WEBHOOK_SECRET"]);
  });
});

describe("the forward target", () => {
  it("is one plain address at another domain", () => {
    const config = klornInboundConfig();
    expect(config.ok && config.forwardTo).toBe("support@example.com");
    expect(config.ok && config.warnings).toEqual([]);
  });

  it("is null without a warning when unset", () => {
    delete process.env.KLORN_MAILBOX_FORWARD_TO;
    const config = klornInboundConfig();
    expect(config.ok && config.forwardTo).toBeNull();
    expect(config.ok && config.warnings).toEqual([]);
  });

  it.each([
    "ops@klorn.ai",
    "OPS@KLORN.AI",
    "a@example.com, b@example.com",
    "Support <support@example.com>",
    "not-an-address",
  ])("is null with a warning naming the variable for %j", (value) => {
    process.env.KLORN_MAILBOX_FORWARD_TO = value;
    const config = klornInboundConfig();
    expect(config.ok && config.forwardTo).toBeNull();
    expect(config.ok && config.warnings.join(" ")).toContain("KLORN_MAILBOX_FORWARD_TO");
  });
});
