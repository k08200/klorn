import { describe, expect, it, vi } from "vitest";

/**
 * getLinkInboxAuthUrl builds the consent URL for linking a SECOND Gmail inbox.
 * The scope set is security-relevant: it must request the full gmail scopes
 * (so the firewall can read/send/modify that account's mail) and nothing more —
 * specifically NO calendar scopes (an inbox link is mail-only), and it must
 * pass through the signed state so the callback can bind it to the right user.
 */

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        generateAuthUrl(opts: { scope: string[]; state: string; access_type: string }) {
          return `https://accounts.google.com/o/oauth2/auth?access_type=${opts.access_type}&state=${opts.state}&scope=${encodeURIComponent(opts.scope.join(" "))}`;
        }
      },
    },
  },
}));

import { getLinkInboxAuthUrl } from "../gmail.js";

describe("getLinkInboxAuthUrl", () => {
  it("requests the full gmail scopes + identity, and NO calendar scope", () => {
    const url = getLinkInboxAuthUrl("signed-state-abc");
    expect(url).toContain("state=signed-state-abc");
    expect(url).toContain("access_type=offline");
    expect(url).toContain("gmail.readonly");
    expect(url).toContain("gmail.send");
    expect(url).toContain("gmail.modify");
    expect(url).toContain("userinfo.email");
    // An inbox link is mail-only — it must not pull in any calendar scope.
    expect(url).not.toContain("calendar");
  });
});
