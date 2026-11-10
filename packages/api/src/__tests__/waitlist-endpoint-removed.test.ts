/**
 * The public waitlist intake is gone, and the beta gate is not.
 *
 * `POST /api/waitlist` was the only way a Waitlist row could ever be created:
 * admin can approve or reject (`routes/admin.ts`), never insert. It had no
 * caller left — no form in `website/`, `packages/web` or `apps/`, and the live
 * landing says "no invite, no waitlist. The only limit is the first 100
 * accounts." Founder decision 2026-08-26: delete the endpoint.
 *
 * What that changes, deliberately: with no intake, `BETA_GATE_ENABLED=true`
 * stops being an approval funnel and becomes a hard close — nobody new can
 * sign up, because nobody new can reach APPROVED. That is a usable emergency
 * switch, but it is not what "beta gate" used to mean, so the second half of
 * this suite pins the gate in place. Deleting the intake must not quietly
 * delete the defence.
 *
 * Asserted against the source text rather than a booted app: the claim is that
 * a route is not registered anywhere, which a request-level test can only
 * probe one path at a time.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

describe("waitlist intake removal", () => {
  it("registers no route under /api/waitlist", () => {
    const index = src("index.ts");
    expect(index).not.toContain("waitlistRoutes");
    expect(index).not.toContain("/api/waitlist");
  });

  it("has no waitlist route module", () => {
    expect(() => src("routes/waitlist.ts")).toThrow();
  });

  it("no longer ships the applicant-facing waitlist mail", () => {
    const email = src("mail/email.ts");
    expect(email).not.toContain("sendWaitlistConfirmationEmail");
    expect(email).not.toContain("sendWaitlistAdminAlert");
  });
});

describe("what the removal must not take with it", () => {
  it("keeps the beta gate reading the Waitlist model on every signup door", () => {
    // Three doors, and social-login.ts:135 says why: "a third signup door must
    // not bypass the waitlist."
    for (const file of ["routes/auth.ts", "auth/social-login.ts"]) {
      const body = src(file);
      expect(body).toContain("BETA_GATE_ENABLED");
      expect(body).toContain("prisma.waitlist.findUnique");
      expect(body).toContain('"APPROVED"');
    }
  });

  it("keeps admin review, the only remaining way a row changes status", () => {
    const admin = src("routes/admin.ts");
    expect(admin).toContain('app.get("/waitlist"');
    expect(admin).toContain('app.patch("/waitlist/:id"');
    // Approving still mails the invite — that path is untouched.
    expect(admin).toContain("sendBetaInviteEmail");
  });

  it("moves creation behind requireAdmin rather than losing it", () => {
    // docs/oauth-verification/README.md §3.5 pre-provisions the Google reviewer
    // and the CASA DAST scanner by creating a row. With the public intake gone
    // and admin able only to approve, that step had no path left.
    const admin = src("routes/admin.ts");
    expect(admin).toContain('app.post("/waitlist"');
    expect(admin).toContain('app.addHook("preHandler", requireAdmin)');
  });

  it("keeps the invite mail itself", () => {
    expect(src("mail/email.ts")).toContain("export async function sendBetaInviteEmail");
  });
});
