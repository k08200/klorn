import { describe, expect, it } from "vitest";
import { checkEnv } from "../checks/env-checks.js";
import type { Check } from "../checks/types.js";

const KEY_32 = Buffer.alloc(32, 7).toString("base64");
const GOOD = {
  POSTGRES_PASSWORD: "a-strong-postgres-password",
  JWT_SECRET: "x".repeat(64),
  TOKEN_ENCRYPTION_KEY: KEY_32,
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-abcdefghijklmnopqrstuvwx",
  ANTHROPIC_API_KEY: "sk-ant-api03-zzzzzzzzzzzzzzzzzzzz",
  WEB_URL: "https://mail.example.test",
  CORS_ORIGINS: "https://mail.example.test,https://other.example.test",
};

const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id);
const allValues = Object.values(GOOD);

describe("checkEnv", () => {
  it("passes a complete self-host env and never prints a value", () => {
    const checks = checkEnv(GOOD, "compose");
    expect(checks.filter((c) => c.status !== "pass")).toEqual([]);
    const text = JSON.stringify(checks);
    for (const value of allValues.filter((v) => !v.startsWith("https://"))) {
      expect(text).not.toContain(value);
    }
    expect(byId(checks, "env.JWT_SECRET")?.detail).toBe("set (64 chars)");
    expect(byId(checks, "env.GOOGLE_CLIENT_SECRET")?.detail).toBe(
      `set (${GOOD.GOOGLE_CLIENT_SECRET.length} chars, GOCSPX- prefix)`,
    );
    expect(byId(checks, "env.TOKEN_ENCRYPTION_KEY")?.detail).toBe("set (decodes to 32 bytes)");
  });

  it("fails every required variable that is missing or empty", () => {
    const checks = checkEnv({ JWT_SECRET: "" }, "compose");
    for (const id of [
      "env.POSTGRES_PASSWORD",
      "env.JWT_SECRET",
      "env.TOKEN_ENCRYPTION_KEY",
      "env.GOOGLE_CLIENT_ID",
      "env.GOOGLE_CLIENT_SECRET",
      "env.llm_provider",
    ]) {
      expect(byId(checks, id)?.status, id).toBe("fail");
    }
  });

  it("fails the untouched placeholders from .env.selfhost.example", () => {
    const checks = checkEnv(
      {
        ...GOOD,
        POSTGRES_PASSWORD: "change-me-strong-password",
        JWT_SECRET: "change-me-long-random-string",
        TOKEN_ENCRYPTION_KEY: "change-me-base64-32-bytes",
        GOOGLE_CLIENT_ID: "your-client-id.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "your-client-secret",
      },
      "compose",
    );
    for (const id of [
      "env.POSTGRES_PASSWORD",
      "env.JWT_SECRET",
      "env.TOKEN_ENCRYPTION_KEY",
      "env.GOOGLE_CLIENT_ID",
      "env.GOOGLE_CLIENT_SECRET",
    ]) {
      expect(byId(checks, id)?.status, id).toBe("fail");
    }
  });

  it("fails an encryption key that does not decode to exactly 32 bytes, as the API would", () => {
    const check = byId(
      checkEnv({ ...GOOD, TOKEN_ENCRYPTION_KEY: Buffer.alloc(24).toString("base64") }, "compose"),
      "env.TOKEN_ENCRYPTION_KEY",
    );
    expect(check).toMatchObject({ status: "fail" });
    expect(check?.detail).toContain("24 bytes");
  });

  it("accepts a valid keyring on the URL path and rejects one whose active id is missing", () => {
    const keyring = {
      ...GOOD,
      TOKEN_ENCRYPTION_KEY: "",
      TOKEN_ENCRYPTION_KEYS: JSON.stringify({ k2: KEY_32 }),
    };
    expect(
      byId(
        checkEnv({ ...keyring, TOKEN_ENCRYPTION_ACTIVE_KEY_ID: "k2" }, "url"),
        "env.TOKEN_ENCRYPTION_KEY",
      ),
    ).toMatchObject({ status: "pass", detail: "keyring set (1 key, active k2)" });
    expect(
      byId(
        checkEnv({ ...keyring, TOKEN_ENCRYPTION_ACTIVE_KEY_ID: "k9" }, "url"),
        "env.TOKEN_ENCRYPTION_KEY",
      ),
    ).toMatchObject({ status: "fail" });
  });

  it("ignores a keyring on the compose path, which never passes it to the api", () => {
    const check = byId(
      checkEnv(
        {
          ...GOOD,
          TOKEN_ENCRYPTION_KEY: "",
          TOKEN_ENCRYPTION_KEYS: JSON.stringify({ k2: KEY_32 }),
          TOKEN_ENCRYPTION_ACTIVE_KEY_ID: "k2",
        },
        "compose",
      ),
      "env.TOKEN_ENCRYPTION_KEY",
    );
    expect(check?.status).toBe("fail");
  });

  it("rejects a keyring key id the API would refuse", () => {
    const check = byId(
      checkEnv(
        {
          ...GOOD,
          TOKEN_ENCRYPTION_KEYS: JSON.stringify({ "bad:id": KEY_32 }),
          TOKEN_ENCRYPTION_ACTIVE_KEY_ID: "bad:id",
        },
        "url",
      ),
      "env.TOKEN_ENCRYPTION_KEY",
    );
    expect(check?.status).toBe("fail");
  });

  it("warns on a $ in a secret, which compose would expand", () => {
    expect(
      byId(checkEnv({ ...GOOD, JWT_SECRET: `${"x".repeat(40)}$HOME` }, "compose"), "env.JWT_SECRET")
        ?.status,
    ).toBe("warn");
  });

  it("warns on a short JWT secret and a client id from somewhere other than Google", () => {
    const checks = checkEnv({ ...GOOD, JWT_SECRET: "short", GOOGLE_CLIENT_ID: "abc" }, "compose");
    expect(byId(checks, "env.JWT_SECRET")?.status).toBe("warn");
    expect(byId(checks, "env.GOOGLE_CLIENT_ID")?.status).toBe("warn");
  });

  it("names the configured LLM providers", () => {
    const checks = checkEnv(
      {
        ...GOOD,
        ANTHROPIC_API_KEY: "",
        GEMINI_API_KEY: "g",
        OPENAI_COMPAT_BASE_URL: "http://h:11434/v1",
      },
      "compose",
    );
    expect(byId(checks, "env.llm_provider")).toMatchObject({
      status: "pass",
      detail: "gemini, openai-compatible",
    });
  });

  it("fails when CORS_ORIGINS does not allow the web app's origin", () => {
    const check = byId(
      checkEnv({ ...GOOD, CORS_ORIGINS: "https://other.example.test" }, "compose"),
      "env.CORS_ORIGINS",
    );
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("https://mail.example.test");
  });

  it("applies the compose defaults when the URLs are unset", () => {
    const { WEB_URL: _w, CORS_ORIGINS: _c, ...rest } = GOOD;
    expect(byId(checkEnv(rest, "compose"), "env.CORS_ORIGINS")?.status).toBe("pass");
  });

  it("does not ask for POSTGRES_PASSWORD outside the compose stack", () => {
    const { POSTGRES_PASSWORD: _p, ...rest } = GOOD;
    expect(byId(checkEnv(rest, "url"), "env.POSTGRES_PASSWORD")).toBeUndefined();
  });
});
