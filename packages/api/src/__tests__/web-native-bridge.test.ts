/**
 * Capacitor shell (Structure A, PR6b): the pure rules behind the web app's
 * native bridge (packages/web/src/lib/native/*), and proof that every entry
 * point is inert on the plain web, where window.Capacitor does not exist.
 *   - Android back: close the open sheet/dialog → history back → home → leave;
 *   - the session token moves to the Keychain/Keystore, reading the old
 *     mobile app's item first so an upgrade keeps people signed in;
 *   - deep links: only `ai.klorn.app://oauth-callback?code=` and
 *     `ai.klorn.app://link-complete?h=<64 hex>` are honoured.
 */
import { describe, expect, it } from "vitest";
import { decideBack } from "../../../web/src/lib/native/back-decision";
import {
  linkRelayQuery,
  parseLinkComplete,
  parseOAuthCallback,
} from "../../../web/src/lib/native/deep-links";
import { hapticSuccess } from "../../../web/src/lib/native/haptics";
import { installNativeKeyboard, nativeKeyboardInset } from "../../../web/src/lib/native/keyboard";
import { planTokenLoad } from "../../../web/src/lib/native/token-migration";

describe("decideBack", () => {
  it("closes an open sheet or dialog first", () => {
    expect(decideBack({ dialogOpen: true, pathname: "/email/e1", canGoBack: true })).toEqual({
      kind: "closeDialog",
    });
  });

  it("goes back in history below a root page", () => {
    expect(decideBack({ dialogOpen: false, pathname: "/email/e1", canGoBack: true })).toEqual({
      kind: "historyBack",
    });
  });

  it("goes home when a deep link opened a page with no history", () => {
    expect(decideBack({ dialogOpen: false, pathname: "/email/e1", canGoBack: false })).toEqual({
      kind: "home",
    });
  });

  it("leaves the app at a root page", () => {
    for (const pathname of ["/", "/today", "/email", "/login", "/today/"]) {
      expect(decideBack({ dialogOpen: false, pathname, canGoBack: true })).toEqual({
        kind: "exit",
      });
    }
  });
});

describe("planTokenLoad", () => {
  it("keeps the Keychain token (the old mobile app's item) and drops a stale copy", () => {
    expect(planTokenLoad({ secure: "jwt-secure", local: "jwt-old" })).toEqual({
      token: "jwt-secure",
      writeSecure: false,
      clearLocal: true,
    });
    expect(planTokenLoad({ secure: "jwt-secure", local: null })).toEqual({
      token: "jwt-secure",
      writeSecure: false,
      clearLocal: false,
    });
  });

  it("moves a localStorage token into the Keychain once", () => {
    expect(planTokenLoad({ secure: null, local: "jwt-local" })).toEqual({
      token: "jwt-local",
      writeSecure: true,
      clearLocal: true,
    });
  });

  it("is signed out when neither has one", () => {
    expect(planTokenLoad({ secure: null, local: null })).toEqual({
      token: null,
      writeSecure: false,
      clearLocal: false,
    });
    expect(planTokenLoad({ secure: "", local: "" })).toEqual({
      token: null,
      writeSecure: false,
      clearLocal: false,
    });
  });
});

describe("deep links", () => {
  it("reads the one-time sign-in code only from the app scheme's oauth-callback", () => {
    expect(
      parseOAuthCallback("ai.klorn.app://oauth-callback?code=abcDEF_123-x", "ai.klorn.app"),
    ).toBe("abcDEF_123-x");
    expect(parseOAuthCallback("evil://oauth-callback?code=abcDEF_123", "ai.klorn.app")).toBeNull();
    expect(
      parseOAuthCallback("ai.klorn.app://link-complete?code=abcDEF_123", "ai.klorn.app"),
    ).toBeNull();
    expect(parseOAuthCallback("ai.klorn.app://oauth-callback?code=<x>", "ai.klorn.app")).toBeNull();
    expect(parseOAuthCallback("not a url", "ai.klorn.app")).toBeNull();
  });

  it("reads the parked link handle only from link-complete with 64 hex", () => {
    const h = "0123456789abcdef".repeat(4);
    expect(parseLinkComplete(`ai.klorn.app://link-complete?h=${h}`, "ai.klorn.app")).toBe(h);
    expect(
      parseLinkComplete(`ai.klorn.app://link-complete?h=${h.slice(1)}`, "ai.klorn.app"),
    ).toBeNull();
    expect(parseLinkComplete(`ai.klorn.app://oauth-callback?h=${h}`, "ai.klorn.app")).toBeNull();
    expect(parseLinkComplete(`other://link-complete?h=${h}`, "ai.klorn.app")).toBeNull();
  });

  it("asks the server to relay an account link to the app only inside the shell", () => {
    expect(linkRelayQuery({ native: true, scheme: "ai.klorn.app" })).toBe(
      "?appScheme=ai.klorn.app",
    );
    expect(linkRelayQuery({ native: false, scheme: "ai.klorn.app" })).toBe("");
    expect(linkRelayQuery({ native: true, scheme: undefined })).toBe("");
  });
});

describe("inert on the plain web (no window.Capacitor)", () => {
  it("haptics resolve without loading a plugin", async () => {
    await expect(hapticSuccess()).resolves.toBe(false);
  });

  it("the keyboard bridge installs nothing and reports no inset", async () => {
    const uninstall = await installNativeKeyboard();
    expect(typeof uninstall).toBe("function");
    expect(nativeKeyboardInset()).toBe(0);
    uninstall();
  });

  it("an account link never asks for the app relay", () => {
    expect(linkRelayQuery()).toBe("");
  });
});
