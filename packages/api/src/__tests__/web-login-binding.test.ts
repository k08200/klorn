import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The web half of the login binding, run against the API half that verifies
// it (the web package has no unit-test runner).
import {
  beginLoginBinding,
  takeLoginBinding,
  withLoginBinding,
} from "../../../web/src/lib/login-binding.js";
import { isLoginBinding, loginBindingMatches } from "../auth/exchange-codes.js";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
    clear: () => items.clear(),
    key: (i) => [...items.keys()][i] ?? null,
    get length() {
      return items.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the web's login binding, as the API verifies it", () => {
  it("sends a binding the API accepts for the nonce the browser keeps", async () => {
    const binding = await beginLoginBinding();
    expect(isLoginBinding(binding)).toBe(true);
    const nonce = takeLoginBinding();
    expect(loginBindingMatches(binding, nonce)).toBe(true);
  });

  it("gives the same answer through the plain-JS digest where crypto.subtle is missing", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: real.getRandomValues.bind(real),
      subtle: undefined,
    });
    const binding = await beginLoginBinding();
    vi.stubGlobal("crypto", real);
    expect(loginBindingMatches(binding, takeLoginBinding())).toBe(true);
  });

  it("hands its nonce out once, and not after it has aged out", async () => {
    await beginLoginBinding();
    expect(takeLoginBinding()).not.toBeNull();
    expect(takeLoginBinding()).toBeNull();
    vi.useFakeTimers();
    try {
      await beginLoginBinding();
      vi.setSystemTime(Date.now() + 16 * 60_000);
      expect(takeLoginBinding()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("appends the binding to a login URL with or without a query", () => {
    expect(withLoginBinding("https://api/x/login", "B")).toBe("https://api/x/login?lb=B");
    expect(withLoginBinding("https://api/x/login?attr=hn", "B")).toBe(
      "https://api/x/login?attr=hn&lb=B",
    );
  });
});
