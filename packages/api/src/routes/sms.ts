/**
 * SMS settings + test routes (admin-only).
 *
 * - GET  /api/sms/phone — return the user's saved E.164 number (or null)
 * - POST /api/sms/phone — save a new E.164 number; rejects malformed
 * - DELETE /api/sms/phone — clear the saved number
 * - POST /api/sms/test — send a one-off "Test message from Klorn" SMS
 *
 * All routes require admin: SMS is admin-MVP only. Non-admins get a 403
 * even if they hit the route directly.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAdmin } from "../auth.js";
import { prisma } from "../db.js";
import { sendSms } from "../notify/sms.js";
import { getSmsUsage } from "../notify/sms-limiter.js";
import { getPhoneNumber, InvalidPhoneNumberError, setPhoneNumber } from "../notify/sms-phone.js";

const PHONE_TYPE = "CONTEXT";
const PHONE_KEY = "phone_number_e164";

const phoneBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["phone"],
  properties: {
    phone: { type: "string", minLength: 4, maxLength: 20 },
  },
} as const;

export async function smsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/phone", async (request) => {
    const userId = getUserId(request);
    const phone = await getPhoneNumber(userId);
    const usage = getSmsUsage(userId);
    return { phone, usage };
  });

  app.post("/phone", { schema: { body: phoneBodySchema } }, async (request, reply) => {
    const userId = getUserId(request);
    const { phone } = request.body as { phone: string };
    try {
      await setPhoneNumber(userId, phone);
    } catch (err) {
      if (err instanceof InvalidPhoneNumberError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    return { phone: await getPhoneNumber(userId) };
  });

  app.delete("/phone", async (request) => {
    const userId = getUserId(request);
    await prisma.memory
      .delete({
        where: { userId_type_key: { userId, type: PHONE_TYPE, key: PHONE_KEY } },
      })
      .catch(() => {
        /* already gone — idempotent */
      });
    return { phone: null };
  });

  app.post("/test", async (request, reply) => {
    const userId = getUserId(request);
    const result = await sendSms(userId, "Test message from Klorn");
    if (!result.sent) {
      return reply.code(400).send({ sent: false, reason: result.reason ?? "unknown" });
    }
    return { sent: true };
  });
}
