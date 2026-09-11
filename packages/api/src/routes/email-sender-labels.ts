/**
 * Sender label routes (2026-09-11) — the user's corrections of who a sender
 * is (mail/sender-labels.ts). Registered by emailRoutes() against the same
 * `/api/email` prefix, like the folder routes.
 */

import type { FastifyInstance } from "fastify";
import { getUserId } from "../auth.js";
import {
  deleteSenderLabel,
  listSenderLabels,
  normalizeSenderLabelKey,
  upsertSenderLabel,
  validateSenderLabel,
} from "../mail/sender-labels.js";

export function registerEmailSenderLabelRoutes(app: FastifyInstance) {
  app.get("/sender-labels", async (request) => {
    const uid = getUserId(request);
    return { labels: await listSenderLabels(uid) };
  });

  // PUT = "this sender is X": create or overwrite the one label for that
  // scope + value. The body is user input headed for a prompt and a chip —
  // validated once, here, with the offending value named.
  app.put("/sender-labels", async (request, reply) => {
    const uid = getUserId(request);
    const result = validateSenderLabel((request.body ?? {}) as Record<string, unknown>);
    if ("error" in result) {
      return reply.code(400).send({ success: false, error: result.error });
    }
    await upsertSenderLabel(uid, result.ok);
    return { success: true, label: result.ok };
  });

  // DELETE = "forget my correction" — the row goes back to the recorded
  // evidence below it (company domain, judge, Gmail tab, reply history).
  app.delete("/sender-labels", async (request, reply) => {
    const uid = getUserId(request);
    const key = normalizeSenderLabelKey((request.query ?? {}) as Record<string, unknown>);
    if ("error" in key) {
      return reply.code(400).send({ success: false, error: key.error });
    }
    const removed = await deleteSenderLabel(uid, key.ok);
    if (!removed) return reply.code(404).send({ success: false, error: "No such label" });
    return { success: true };
  });
}
