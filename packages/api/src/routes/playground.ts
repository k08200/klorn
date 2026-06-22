/**
 * Public, login-free playground for the 4-tier firewall.
 *
 * Why this exists: every real onboarding path (OAuth, Workspace admin policy)
 * gates a visitor out before they ever see the classifier. The playground
 * removes that wall for the *experience* step — paste an email, bring your own
 * OpenRouter/Gemini key, see the tier the real `judgeEmail` would assign. It
 * is a top-of-funnel demo, NOT a measurement of per-user recall (the visitor
 * self-selects the input, so it cannot test what the firewall would miss).
 *
 * Security posture (public endpoint on a public repo):
 *  - No auth, strict JSON schema (`additionalProperties: false`).
 *  - Per-IP rate limit (each call is one paid LLM inference on the visitor's
 *    own key, but we still cap to blunt scripted abuse of the route itself).
 *  - The visitor's API key is used in-memory for one call and is NEVER
 *    persisted, logged, or attached to Sentry. Email content is never logged.
 */

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { judgeEmail } from "../poc-judge.js";
import type { ProviderCredentials } from "../providers/index.js";
import { TIERS } from "../tiers.js";

// Scope provider cooldown state to the KEY, not the IP. A BYOK playground sees
// a different key per visitor; an IP-scoped cooldown means one person's bad key
// (a 401 gets marked as a provider lockout) blocks every later request from the
// same IP — including a corrected key — for hours. Hashing the key isolates
// cooldowns per credential: a fixed key gets a fresh bucket and works at once,
// while a genuinely rate-limited key still backs off. Bounded by distinct keys.
function keyScope(apiKey: string): string {
  return `playground:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

const classifyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "subject", "apiKey"],
  properties: {
    from: { type: "string", minLength: 1, maxLength: 320 },
    subject: { type: "string", minLength: 1, maxLength: 998 },
    snippet: { type: "string", maxLength: 4000 },
    provider: { type: "string", enum: ["openrouter", "gemini", "openai"] },
    apiKey: { type: "string", minLength: 8, maxLength: 400 },
    // No `:free` enforcement: the visitor uses their own key and pays for
    // whatever model they pick. `playgroundOnly` walls this off from the
    // server's keys, so a paid model never costs Klorn anything.
    model: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;

const feedbackBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["predictedTier", "correctTier"],
  properties: {
    // Content is accepted but only its length is recorded — never the text.
    subject: { type: "string", maxLength: 998 },
    predictedTier: { type: "string", enum: [...TIERS] },
    correctTier: { type: "string", enum: [...TIERS] },
    model: { type: "string", maxLength: 120 },
    source: { type: "string", maxLength: 40 },
  },
} as const;

// Defense-in-depth: redact anything shaped like an OpenRouter (sk-or-…) or
// Google (AIza…) key before it reaches a log line, in case a provider SDK
// echoes the credential inside an error message.
function scrubKeys(text: string): string {
  return text.replace(
    /(?:sk-or-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{16,})/g,
    "[REDACTED]",
  );
}

type PlaygroundProvider = "openrouter" | "gemini" | "openai";

interface ClassifyBody {
  from: string;
  subject: string;
  snippet?: string;
  provider?: PlaygroundProvider;
  apiKey: string;
  model?: string;
}

interface FeedbackBody {
  subject?: string;
  predictedTier: string;
  correctTier: string;
  model?: string;
  source?: string;
}

export function playgroundRoutes(app: FastifyInstance) {
  app.post(
    "/classify",
    {
      schema: { body: classifyBodySchema },
      config: { rateLimit: { max: 8, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = request.body as ClassifyBody;
      const provider: PlaygroundProvider =
        body.provider === "gemini" || body.provider === "openai" ? body.provider : "openrouter";

      // Build credentials from the request body and pass straight through to
      // the classifier. No userId → the per-user cost ledger is bypassed; the
      // global cost gate is skipped (playgroundOnly). quotaScope is keyed on the
      // credential so a bad key never poisons the next request's cooldown.
      const credentials: ProviderCredentials = {
        openRouterApiKey: provider === "openrouter" ? body.apiKey : null,
        geminiApiKey: provider === "gemini" ? body.apiKey : null,
        openAiApiKey: provider === "openai" ? body.apiKey : null,
        quotaScope: keyScope(body.apiKey),
        // Fail closed: never fall through to the server's env keys.
        playgroundOnly: true,
      };

      // Capture the real upstream failure reason (e.g. OpenRouter "401 User
      // not found", "model not found") so the visitor sees what to fix instead
      // of a generic message. Keys are scrubbed before it leaves the server.
      let llmError: string | undefined;

      try {
        const result = await judgeEmail(
          {
            from: body.from.trim(),
            subject: body.subject.trim(),
            snippet: body.snippet?.trim() || null,
            labels: [],
          },
          undefined,
          undefined,
          credentials,
          body.model,
          (message) => {
            llmError = scrubKeys(message);
          },
        );

        // `keyword-fallback` means the LLM never ran (the provider call threw
        // and judgeEmail silently degraded). In a demo, showing that keyword
        // guess as if it were Klorn's real verdict is misleading — surface it
        // as a failure so the visitor fixes their key/model instead of trusting
        // a fake tier. `fast-path` (deterministic marketing → SILENT) is a real
        // verdict and is returned normally.
        if (result.source === "keyword-fallback") {
          return reply.code(502).send({
            error:
              "The model didn't run — usually an invalid API key, an unavailable model, or no credit on that model. Check your key and try a different model.",
            // The verbatim upstream error (key-scrubbed, bounded) so the
            // visitor can self-diagnose: a 401 means the key, a 404 the model.
            detail: llmError?.slice(0, 300),
          });
        }

        return reply.code(200).send({
          tier: result.tier,
          reason: result.reason,
          features: result.features,
          source: result.source,
        });
      } catch (err) {
        // Log WHY (message only) but NEVER the body or the key. captureError
        // is intentionally not called with any request context here. Scrub any
        // key-shaped token in case a provider SDK embedded it in the message.
        const message = scrubKeys(err instanceof Error ? err.message : String(err));
        console.warn(`[PLAYGROUND] classify failed: ${message}`);
        return reply.code(502).send({
          error: "Classification failed. Check your API key and model, then retry.",
        });
      }
    },
  );

  app.post(
    "/feedback",
    {
      schema: { body: feedbackBodySchema },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = request.body as FeedbackBody;
      // The disagreement signal — the only override-like data the playground
      // can produce. Structured-logged (no DB migration yet); persisting to a
      // table is a fast-follow. Email content is reduced to a length so no PII
      // lands in the log pipeline.
      console.log(
        `[PLAYGROUND_FEEDBACK] predicted=${body.predictedTier} correct=${body.correctTier} ` +
          `model=${body.model ?? "?"} source=${body.source ?? "?"} subjectLen=${body.subject?.length ?? 0}`,
      );
      return reply.code(200).send({ ok: true });
    },
  );
}
