/**
 * Shared credential redactor — the shapes that actually show up in the wild.
 *
 * BYOK makes a user-supplied provider key a first-class secret, so every text
 * surface that can echo one (operator log, playground error, Sentry breadcrumb)
 * has to go through one redactor instead of three near-copies. These cases are
 * the ones the old per-site patterns missed:
 *   - OpenAI's MASKED form ("sk-proj-****…abcd") — the `*` broke a
 *     [A-Za-z0-9_-] character class, so the mask passed through verbatim.
 *   - Google's `AIza…` and `AQ.…` keys — only the playground route knew them.
 *   - a credential riding in a URL query parameter (`?key=…`), which is how
 *     the Gemini native API used to be called.
 */

import { describe, expect, it } from "vitest";
import {
  redactCredentialQueryParams,
  redactCredentialShapes,
  redactCredentials,
} from "../security/credential-redaction.js";

describe("redactCredentialShapes", () => {
  it("redacts an unmasked OpenAI project key", () => {
    const out = redactCredentialShapes("401 Incorrect API key: sk-proj-AbCd1234EfGh5678IjKl");
    expect(out).not.toContain("AbCd1234EfGh5678IjKl");
    expect(out).toContain("sk-***");
  });

  it("redacts OpenAI's masked echo form, which has only a few chars before the first *", () => {
    // The real shape OpenAI returns in 401 bodies. The previous
    // /sk-[A-Za-z0-9_-]{8,}/ could not match it: `-` then `*` ended the class
    // after four characters ("proj"), so the whole mask survived into the log.
    const out = redactCredentialShapes("Incorrect API key provided: sk-proj-****************abcd");
    expect(out).not.toContain("abcd");
    expect(out).toContain("sk-***");
  });

  it("redacts the short dotted mask form too", () => {
    const out = redactCredentialShapes("key sk-...A1b2 is invalid");
    expect(out).not.toContain("A1b2");
  });

  it("redacts OpenAI service-account and admin key prefixes", () => {
    expect(redactCredentialShapes("sk-svcacct-AbCd1234EfGh5678")).not.toContain("AbCd1234");
    expect(redactCredentialShapes("sk-admin-AbCd1234EfGh5678")).not.toContain("AbCd1234");
  });

  it("redacts an OpenRouter sk-or-v1 key", () => {
    const out = redactCredentialShapes("sk-or-v1-supersecret-do-not-leak-1234567890");
    expect(out).not.toContain("supersecret");
  });

  it("redacts a Google AIza… key", () => {
    const out = redactCredentialShapes("API key not valid: AIzaSyA0123456789abcdefghijklmnopqrstu");
    expect(out).not.toContain("SyA0123456789");
    expect(out).toContain("AIza***");
  });

  it("redacts a Google AQ.… key — the newer form gemini-native exists to support", () => {
    const out = redactCredentialShapes("auth failed for AQ.Ab8RN6J0123456789abcdefghij");
    expect(out).not.toContain("Ab8RN6J0123456789");
    expect(out).toContain("AQ.***");
  });

  it("redacts a bearer token while keeping the scheme readable", () => {
    const out = redactCredentialShapes("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toMatch(/Bearer \*\*\*/i);
  });

  it("leaves text with no credential untouched", () => {
    const msg = "429 Too Many Requests: rate limit exceeded for model gemini-2.5-flash";
    expect(redactCredentialShapes(msg)).toBe(msg);
  });

  it("is idempotent — redacting already-redacted text does not re-mangle it", () => {
    const once = redactCredentialShapes("sk-proj-AbCd1234EfGh5678IjKl and AIzaSyA0123456789abcdef");
    expect(redactCredentialShapes(once)).toBe(once);
  });
});

describe("redactCredentialQueryParams", () => {
  it("redacts ?key= — the Gemini native API's credential parameter", () => {
    const out = redactCredentialQueryParams(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AQ.Ab8RN6Jsecret&alt=sse",
    );
    expect(out).not.toContain("AQ.Ab8RN6Jsecret");
    expect(out).toContain("key=[REDACTED]");
    // Non-credential parameters stay readable — that is the whole point of
    // redacting per-parameter instead of dropping the query string.
    expect(out).toContain("alt=sse");
  });

  it("redacts a bare query string, with no leading URL", () => {
    // Sentry's fetch breadcrumb stores exactly this: parsedUrl.search.
    const out = redactCredentialQueryParams("?key=AQ.Ab8RN6Jsecret&alt=sse");
    expect(out).not.toContain("AQ.Ab8RN6Jsecret");
  });

  it("redacts a credential parameter that is first with no separator at all", () => {
    expect(redactCredentialQueryParams("key=AQ.Ab8RN6Jsecret")).not.toContain("AQ.Ab8RN6Jsecret");
  });

  it("covers the other credential parameter names", () => {
    for (const name of [
      "api_key",
      "apikey",
      "apiKey",
      "access_token",
      "refresh_token",
      "id_token",
      "token",
      "client_secret",
      "password",
      "secret",
      "signature",
      "code",
      "state",
    ]) {
      const out = redactCredentialQueryParams(`https://x.test/cb?${name}=SENSITIVE0123456789`);
      expect(out, name).not.toContain("SENSITIVE0123456789");
    }
  });

  it("leaves a query string with no credential parameter alone", () => {
    const url = "https://x.test/v1?model=gemini-2.5-flash&alt=sse";
    expect(redactCredentialQueryParams(url)).toBe(url);
  });
});

describe("redactCredentials", () => {
  it("catches a key in a parameter AND a key loose in the same text", () => {
    const out = redactCredentials(
      "GET https://x.test/v1?key=AQ.Ab8RN6Jsecret failed for sk-proj-AbCd1234EfGh5678IjKl",
    );
    expect(out).not.toContain("AQ.Ab8RN6Jsecret");
    expect(out).not.toContain("AbCd1234EfGh5678IjKl");
  });

  it("catches a credential in an unknown parameter name by its shape alone", () => {
    // Defence in depth: the parameter-name denylist cannot know every name a
    // provider might invent, so the shape pass runs over the same text.
    const out = redactCredentials("https://x.test/v1?surprise=AIzaSyA0123456789abcdefghijklmnop");
    expect(out).not.toContain("SyA0123456789");
  });
});

/**
 * Bypasses found by probing the first version of these patterns against
 * real-shaped keys (2026-10-30 security review of this change).
 *
 * All of them came from the same mistake: anchoring the key prefixes on `\b`.
 * A word boundary needs a non-word character to the left, and the characters
 * that actually precede a key in the wild are often word characters — the `D`
 * of `%3D`, the `0` of `%20`, the `n` of an escaped `\n`. The anchor existed
 * only to stop "risk-assessment" matching bare `sk-`, so it now guards only
 * that case and the distinctive prefixes carry no anchor at all.
 */
describe("redactCredentials — anchor bypasses", () => {
  const AIZA = "AIzaSyA0123456789abcdefghijklmnopqrstu";
  const PROJ = "sk-proj-AbCd1234EfGh5678IjKl";

  it("redacts a key inside a percent-encoded nested URL", () => {
    // A redirect parameter or a Referer header carrying another URL.
    const out = redactCredentials(`https://x.test/r?u=https%3A%2F%2Fy.test%2Fv%3Fkey%3D${AIZA}`);
    expect(out).not.toContain(AIZA);
  });

  it("redacts a key after a percent-encoded space", () => {
    expect(redactCredentials(`https://x.test/r?h=Bearer%20${PROJ}`)).not.toContain(PROJ);
  });

  it("redacts a key after an escaped newline in a JSON string", () => {
    expect(redactCredentials(`{"m":"line1\\n${PROJ}"}`)).not.toContain(PROJ);
  });

  it("redacts a key glued to a leading underscore or digit", () => {
    expect(redactCredentials(`_${PROJ}`)).not.toContain(PROJ);
    expect(redactCredentials(`1${PROJ}`)).not.toContain(PROJ);
  });

  it("redacts an AQ.… key whose tail contains a dot", () => {
    const out = redactCredentials("AQ.Ab8RN6J0123.456789abcdefghij");
    expect(out).not.toContain("456789abcdefghij");
  });

  it("still does not mangle ordinary hyphenated words that end in sk-", () => {
    // The whole reason the bare `sk-` pattern keeps a guard.
    for (const word of ["risk-assessment", "task-queue", "desk-side", "disk-usage"]) {
      expect(redactCredentials(`a ${word} b`), word).toContain(word);
    }
  });
});

describe("redactCredentialQueryParams — parameter names", () => {
  const OPAQUE = "OPAQUE0123456789abcdef";

  it("matches credential parameter names by substring, not exact equality", () => {
    // These all leaked under the original ^…$ denylist. `gemini_api_key` is
    // one of this API's OWN request-body field names.
    for (const name of [
      "gemini_api_key",
      "x-api-key",
      "auth_token",
      "api_token",
      "private_key",
      "X-Amz-Signature",
      "openRouterApiKey",
      "client_credentials",
    ]) {
      const out = redactCredentialQueryParams(`https://x.test/v1?${name}=${OPAQUE}`);
      expect(out, name).not.toContain(OPAQUE);
    }
  });

  it("does not redact parameters that merely look similar", () => {
    // Over-redaction costs readability, so the ambiguous short names stay
    // exact-match: `code` and `state` are credentials, `country_code` is not.
    for (const name of ["country_code", "statement", "design", "model", "alt"]) {
      const out = redactCredentialQueryParams(`https://x.test/v1?${name}=plainvalue`);
      expect(out, name).toContain("plainvalue");
    }
  });

  it("does not let a non-credential pair swallow the credential pair after it", () => {
    for (const text of [`?a=1;key=${OPAQUE}`, `?alt=sse%26key=${OPAQUE}`]) {
      expect(redactCredentialQueryParams(text), text).not.toContain(OPAQUE);
    }
  });
});
