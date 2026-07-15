/**
 * CI/monitoring noise detector (#793 — the SILENT split of the automated
 * sender floor).
 *
 * The rule is deliberately NARROWER than "CI sender + routine → SILENT":
 * the eval ground truth pins Vercel "Deployment completed: klorn-web" as
 * QUEUE (a prod deploy of your own site is worth a glance), while the
 * founder's dogfood screenshot pins "Failed preview deployment" and
 * "TEST: Monitor is DOWN" as pure noise. The reconciling boundary is:
 *   (a) non-production context (test/preview/staging/sandbox), or
 *   (b) a monitoring pulse (up/recovered/resolved/weekly report).
 * Everything else — including real "DOWN" alerts and prod deploy results —
 * stays on the QUEUE floor.
 */

import { describe, expect, it } from "vitest";
import { detectCiNoise } from "../judge/ci-noise.js";

function email(from: string, subject: string, snippet = "") {
  return { id: "t", from, subject, snippet, body: null, labels: [] };
}

describe("detectCiNoise", () => {
  it("silences non-production CI notices (founder screenshot cases)", () => {
    expect(
      detectCiNoise(email("Vercel <noreply@vercel.com>", "Failed preview deployment: klorn-web")),
    ).not.toBeNull();
    expect(
      detectCiNoise(email("UptimeRobot <alert@uptimerobot.com>", "TEST: Monitor is DOWN (api)")),
    ).not.toBeNull();
    expect(
      detectCiNoise(email("CircleCI <builds@circleci.com>", "Build failed on staging")),
    ).not.toBeNull();
  });

  it("silences routine monitoring pulses", () => {
    expect(
      detectCiNoise(email("UptimeRobot <alert@uptimerobot.com>", "Monitor is UP: klorn-api")),
    ).not.toBeNull();
    expect(
      detectCiNoise(email("UptimeRobot <noreply@uptimerobot.com>", "Weekly uptime report")),
    ).not.toBeNull();
    expect(
      detectCiNoise(email("Pingdom <alert@pingdom.com>", "Monitor recovered: checkout flow")),
    ).not.toBeNull();
  });

  it("keeps real operational alerts visible (the founder's stated fear)", () => {
    expect(
      detectCiNoise(email("UptimeRobot <alert@uptimerobot.com>", "Monitor is DOWN: prod-api")),
    ).toBeNull();
    expect(
      detectCiNoise(email("Vercel <noreply@vercel.com>", "Deployment failed: klorn-web")),
    ).toBeNull();
  });

  it("keeps prod deploy results visible (eval ground truth: QUEUE)", () => {
    expect(
      detectCiNoise(email("Vercel <noreply@vercel.com>", "Deployment completed: klorn-web")),
    ).toBeNull();
  });

  it("never touches security/account mail, even from monitoring-looking senders", () => {
    expect(
      detectCiNoise(
        email("Google <no-reply@accounts.google.com>", "Security alert: new sign-in on Mac"),
      ),
    ).toBeNull();
    expect(
      detectCiNoise(
        email("StatusCake <alerts@statuscake.com>", "TEST alert: unusual sign-in detected"),
      ),
    ).toBeNull();
  });

  it("ignores human senders entirely", () => {
    expect(
      detectCiNoise(email("Dana Kim <dana@acme.com>", "Preview build for the demo?")),
    ).toBeNull();
  });

  it("ignores automated senders with no CI/monitoring context", () => {
    expect(
      detectCiNoise(
        email("Stripe <noreply@stripe.com>", "Your invoice from Acme Inc is available"),
      ),
    ).toBeNull();
    expect(
      detectCiNoise(email("Medium <updates@medium.com>", "Stories digest picked for you")),
    ).toBeNull();
  });
});
