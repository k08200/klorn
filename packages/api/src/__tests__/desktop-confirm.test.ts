import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginDesktopConfirmation,
  desktopConfirmPage,
  pairingCode,
  takeDesktopConfirmation,
} from "../auth/desktop-confirm.js";

// The desktop poll sign-in (no app scheme) used to park the JWT for whoever
// polls with the nonce's PKCE verifier. An attacker who minted the nonce could
// send a victim the login link and take the victim's session. Now the browser
// that completed the sign-in must confirm it, against a pairing code the app
// shows, before anything is parked.

afterEach(() => {
  vi.useRealTimers();
});

describe("pairingCode", () => {
  it("is eight Crockford base32 characters in two groups, fixed for a nonce", () => {
    const code = pairingCode("nonce-1");
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(pairingCode("nonce-1")).toBe(code);
    expect(pairingCode("nonce-2")).not.toBe(code);
  });
});

describe("a pending desktop confirmation", () => {
  it("hands its nonce and session out once", () => {
    const id = beginDesktopConfirmation("nonce-1", "jwt-1");
    expect(id).toMatch(/^[a-f0-9]{40}$/);
    expect(takeDesktopConfirmation(id)).toEqual({ nonce: "nonce-1", jwt: "jwt-1" });
    expect(takeDesktopConfirmation(id)).toBeNull();
  });

  it("is gone after five minutes", () => {
    vi.useFakeTimers();
    const id = beginDesktopConfirmation("nonce-1", "jwt-1");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(takeDesktopConfirmation(id)).toBeNull();
  });

  it("refuses an id it never issued, of any shape", () => {
    expect(takeDesktopConfirmation("nope")).toBeNull();
    expect(takeDesktopConfirmation(undefined)).toBeNull();
    expect(takeDesktopConfirmation(42)).toBeNull();
  });
});

describe("the confirmation page", () => {
  it("shows the code and posts the id to the confirm endpoint, with no script", () => {
    const html = desktopConfirmPage("ab12", "K7Q2-M9X4");
    expect(html).toContain("K7Q2-M9X4");
    expect(html).toContain('<form method="post" action="/api/auth/desktop-confirm">');
    expect(html).toContain('<input type="hidden" name="confirm" value="ab12">');
    expect(html).not.toContain("<script");
  });

  it("escapes what it puts into markup", () => {
    const html = desktopConfirmPage('"><x', "<b>");
    expect(html).not.toContain('"><x');
    expect(html).not.toContain("<b>");
  });
});
