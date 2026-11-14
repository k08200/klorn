/**
 * Rules DSL routes (RULES_DSL_ENABLED, off by default; `cohort` opens them to
 * ROLLOUT_COHORT_USER_IDS only). docs/design/rules-dsl.md §11:
 *
 *   GET  /api/email/rules/dsl/export    the user's rules as text + baseHash
 *   POST /api/email/rules/dsl/validate  { text } → errors with line:column
 *   POST /api/email/rules/dsl/dry-run   { text, limit? } → lane changes, no write
 *   POST /api/email/rules/dsl/apply     { text, baseHash } → replace the pins
 *
 * While the flag is off every route answers Fastify's default 404 before any
 * auth (darkRouteGate); in cohort mode a user outside it gets the same 404
 * after auth (cohortGate). The default-deny session guard (#1748) covers every
 * route as well. Classification only: the text can set a sender's lane and
 * nothing else — no reply, send, archive or calendar action.
 */

import type {
  RulesDslApplyResponse,
  RulesDslInvalidResponse,
  RulesDslValidateResponse,
} from "@klorn/contract";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { RULES_DSL_FLAG, rulesDslLive } from "../config.js";
import {
  applyRulesFor,
  DRY_RUN_DEFAULT_MAILS,
  DRY_RUN_MAX_MAILS,
  dryRunFor,
  exportRulesFor,
} from "../mail/rules-dsl-store.js";
import { checkRules, type DslFailure } from "../rules-dsl/index.js";
import { cohortGate } from "./cohort-gate.js";
import { darkRouteGate } from "./dark-route-gate.js";

const RULES_DSL_FLAGS = [RULES_DSL_FLAG] as const;

/**
 * The JSON body around a 64 KiB text: escaping can at most double it (\u
 * escapes for non-ASCII aside), plus the envelope. Larger is refused before
 * it is parsed (413); the text's own 64 KiB limit then answers in DSL terms.
 */
const BODY_LIMIT_BYTES = 256 * 1024;

const textBody = {
  type: "object",
  required: ["text"],
  additionalProperties: false,
  properties: { text: { type: "string" } },
} as const;

const dryRunBody = {
  type: "object",
  required: ["text"],
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: DRY_RUN_MAX_MAILS },
  },
} as const;

const applyBody = {
  type: "object",
  required: ["text", "baseHash"],
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    baseHash: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

function invalid(reply: FastifyReply, failure: DslFailure) {
  return reply.code(400).send({
    error: "The rules text has errors.",
    code: "invalid-rules",
    errors: failure.errors,
    truncated: failure.truncated,
  } satisfies RulesDslInvalidResponse);
}

export async function rulesDslRoutes(app: FastifyInstance) {
  app.addHook("onRequest", darkRouteGate(rulesDslLive));

  app.get(
    "/export",
    {
      preHandler: [requireAuth, cohortGate(RULES_DSL_FLAGS)],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => exportRulesFor(getUserId(request)),
  );

  app.post(
    "/validate",
    {
      preHandler: [requireAuth, cohortGate(RULES_DSL_FLAGS)],
      bodyLimit: BODY_LIMIT_BYTES,
      schema: { body: textBody },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { text } = request.body as { text: string };
      const result = checkRules(text);
      return (
        result.ok
          ? { ok: true, ruleCount: result.rules.length, errors: [], truncated: false }
          : { ok: false, ruleCount: 0, errors: result.errors, truncated: result.truncated }
      ) satisfies RulesDslValidateResponse;
    },
  );

  app.post(
    "/dry-run",
    {
      preHandler: [requireAuth, cohortGate(RULES_DSL_FLAGS)],
      bodyLimit: BODY_LIMIT_BYTES,
      schema: { body: dryRunBody },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { text, limit } = request.body as { text: string; limit?: number };
      const result = checkRules(text);
      if (!result.ok) return invalid(reply, result);
      return dryRunFor(getUserId(request), result.rules, limit ?? DRY_RUN_DEFAULT_MAILS);
    },
  );

  app.post(
    "/apply",
    {
      preHandler: [requireAuth, cohortGate(RULES_DSL_FLAGS)],
      bodyLimit: BODY_LIMIT_BYTES,
      schema: { body: applyBody },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const userId = getUserId(request);
      const { text, baseHash } = request.body as { text: string; baseHash: string };
      const result = checkRules(text);
      if (!result.ok) return invalid(reply, result);
      const outcome = await applyRulesFor(userId, result.rules, text, baseHash);
      if (outcome.kind === "conflict") {
        return reply.code(409).send({
          error: "Your rules changed since you loaded them. Reload, then apply again.",
          code: "rules-changed",
        });
      }
      const fresh = await exportRulesFor(userId);
      return {
        ...outcome.result,
        text: fresh.text,
        baseHash: fresh.baseHash,
        applicable: fresh.applicable,
      } satisfies RulesDslApplyResponse;
    },
  );
}
