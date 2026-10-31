/**
 * The JSON schema handed to the model for facts v1. It mirrors
 * facts-schema.ts (the canonical TS types) and is strict: every field is
 * required, no extra keys. Strict-mode providers (OpenAI json_schema,
 * Anthropic forced tool) need nullable fields spelled as type unions. No
 * maxItems: not every strict-mode provider accepts it; parseFactsV1 caps the
 * arrays instead.
 *
 * The model's answer is still re-validated by parseFactsV1 — this schema
 * only steers generation; it is not a trust boundary.
 */

import {
  ADDRESSED_TO,
  ASK_KINDS,
  MAIL_KINDS,
  RISKS,
  THREAD_TURNS,
  TRANSACTION_KINDS,
} from "./facts-schema.js";

export const FACTS_TOOL_NAME = "record_facts";

const isoDateTime = {
  type: "string",
  description:
    "Absolute ISO-8601 date-time WITH offset (e.g. 2026-11-03T18:00:00+09:00), resolved against the mail's Date header.",
} as const;

export const FACTS_V1_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "asks",
    "addressedTo",
    "threadTurn",
    "event",
    "transaction",
    "risk",
    "kind",
    "ambiguous",
  ],
  properties: {
    asks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "object", "due", "evidence"],
        properties: {
          kind: { type: "string", enum: [...ASK_KINDS] },
          object: { type: "string", description: "What is asked, in a few words." },
          due: { anyOf: [isoDateTime, { type: "null" }] },
          evidence: {
            type: "string",
            description: "Exact quote copied from the subject or body, unchanged.",
          },
        },
      },
    },
    addressedTo: { type: "string", enum: [...ADDRESSED_TO] },
    threadTurn: { type: "string", enum: [...THREAD_TURNS] },
    event: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["proposedTimes", "hasInvite", "conflict"],
          properties: {
            proposedTimes: { type: "array", items: isoDateTime },
            hasInvite: { type: "boolean" },
            conflict: { type: ["boolean", "null"] },
          },
        },
        { type: "null" },
      ],
    },
    transaction: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "actionRequired"],
          properties: {
            kind: { type: "string", enum: [...TRANSACTION_KINDS] },
            actionRequired: { type: "boolean" },
          },
        },
        { type: "null" },
      ],
    },
    risk: { type: "array", items: { type: "string", enum: [...RISKS] } },
    kind: { type: "string", enum: [...MAIL_KINDS] },
    ambiguous: { type: "boolean" },
  },
} as const;
