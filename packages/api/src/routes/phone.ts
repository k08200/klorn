/**
 * Phone escalation webhooks — Twilio <Gather> digits + call status.
 *
 * CASA Tier 2 baseline: every request MUST carry a valid X-Twilio-Signature
 * (twilio.validateRequest over the full public URL + form params) or it is
 * rejected with 403. The gather token in the query string is a secondary
 * capability check that maps the callback to one PhoneEscalation row.
 *
 * Digits contract (see buildEscalationTwiml):
 *   1 → re-<Say> the stored sanitized title and gather again
 *   2 → mark ACKNOWLEDGED, say "Acknowledged. Goodbye."
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import twilio from "twilio";
import { prisma } from "../db.js";
import { buildEscalationTwiml, buildSayHangupTwiml, publicBaseUrl } from "../notify/phone-twiml.js";

/** Twilio terminal CallStatus values that mean the call never connected. */
const TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "busy",
  "failed",
  "no-answer",
  "canceled",
]);

type TwilioParams = Record<string, string>;

function asParams(body: unknown): TwilioParams {
  if (body && typeof body === "object") return body as TwilioParams;
  return {};
}

/**
 * Validate X-Twilio-Signature against the full public URL (incl. query
 * string) and the POSTed form params. Fails closed: missing auth token,
 * missing signature, or missing public URL all reject.
 */
function isVerifiedTwilioRequest(request: FastifyRequest): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  if (!authToken) return false;

  const signature = request.headers["x-twilio-signature"];
  if (typeof signature !== "string" || !signature) return false;

  const baseUrl = publicBaseUrl();
  if (!baseUrl) return false;

  const url = `${baseUrl}${request.url}`;
  return twilio.validateRequest(authToken, signature, url, asParams(request.body));
}

async function findEscalationByToken(token: string | undefined) {
  if (!token) return null;
  return prisma.phoneEscalation.findUnique({ where: { gatherToken: token } });
}

export async function phoneRoutes(app: FastifyInstance) {
  // Twilio posts application/x-www-form-urlencoded; Fastify has no default
  // parser for it. Scoped to this plugin so the rest of the app is untouched.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const params: TwilioParams = {};
        for (const [key, value] of new URLSearchParams((body as string) || "")) {
          params[key] = value;
        }
        done(null, params);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // POST /api/phone/gather?token=... — keypad input from the <Gather> verb
  app.post("/gather", async (request, reply) => {
    if (!isVerifiedTwilioRequest(request)) {
      return reply.code(403).send({ error: "Invalid Twilio signature" });
    }

    const { token } = request.query as { token?: string };
    const escalation = await findEscalationByToken(token);
    if (!escalation) return reply.code(404).send({ error: "Unknown escalation" });

    const digits = asParams(request.body).Digits;

    if (digits === "2") {
      await prisma.phoneEscalation.update({
        where: { id: escalation.id },
        data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date() },
      });
      return reply.type("text/xml").send(buildSayHangupTwiml("Acknowledged. Goodbye."));
    }

    // Any keypress proves a human answered; never downgrade ACKNOWLEDGED.
    if (escalation.status === "PLACED") {
      await prisma.phoneEscalation.update({
        where: { id: escalation.id },
        data: { status: "ANSWERED" },
      });
    }

    if (digits === "1") {
      const baseUrl = publicBaseUrl();
      const gatherUrl = `${baseUrl}/api/phone/gather?token=${escalation.gatherToken}`;
      return reply.type("text/xml").send(buildEscalationTwiml(escalation.title, gatherUrl));
    }

    return reply.type("text/xml").send(buildSayHangupTwiml("Goodbye."));
  });

  // POST /api/phone/status?token=... — terminal call status callback
  app.post("/status", async (request, reply) => {
    if (!isVerifiedTwilioRequest(request)) {
      return reply.code(403).send({ error: "Invalid Twilio signature" });
    }

    const { token } = request.query as { token?: string };
    const escalation = await findEscalationByToken(token);
    if (!escalation) return reply.code(404).send({ error: "Unknown escalation" });

    const callStatus = asParams(request.body).CallStatus ?? "";
    if (TERMINAL_FAILURE_STATUSES.has(callStatus) && escalation.status === "PLACED") {
      await prisma.phoneEscalation.update({
        where: { id: escalation.id },
        data: { status: "FAILED" },
      });
      console.log(`[PHONE] Escalation ${escalation.id} marked FAILED (CallStatus=${callStatus})`);
    }

    return reply.send({ received: true });
  });
}
