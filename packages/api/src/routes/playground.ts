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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { usdToFractionalCents } from "../billing/cents.js";
import { DEMO_DAILY_BUDGET_CENTS, PLAYGROUND_NO_KEY_DEMO_ENABLED } from "../config.js";
import { judgeEmail } from "../judge/poc-judge.js";
import { TIERS } from "../judge/tiers.js";
import type { ProviderCredentials } from "../providers/index.js";

// Strip CR/LF/control chars from any user-supplied value before it reaches a
// log line, so a crafted model/source field can't forge or split log entries.
function sanitizeForLog(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
  return value.replace(/[\x00-\x1F\x7F]/g, " ").slice(0, 200);
}

const classifyBodySchema = {
  type: "object",
  additionalProperties: false,
  // apiKey is optional at the schema level: without it the request is routed
  // to the server-paid demo path, which is OFF by default
  // (PLAYGROUND_NO_KEY_DEMO_ENABLED) and answers 401 key_required when dark.
  required: ["from", "subject"],
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
  apiKey?: string;
  model?: string;
}

interface FeedbackBody {
  subject?: string;
  predictedTier: string;
  correctTier: string;
  model?: string;
  source?: string;
}

// ── Key-free demo mode (server-paid, triple defense) ─────────────────────
//
// A request WITHOUT an apiKey runs one classification on the server's own env
// keys so a visitor sees value before connecting anything. Server money is at
// stake on a zero-auth route, so three independent walls guard it:
//   1. Per-IP rate limit (3/min AND 10/UTC-day, in-memory).
//   2. Global daily demo budget, pre-charged per call in fractional cents.
//   3. Model pinned to the server default (JUDGE_MODEL); visitor-supplied
//      provider/model fields are ignored on this path. Input length caps and
//      the judge's strict classify-only JSON prompt are shared with BYOK.
// The whole path sits behind PLAYGROUND_NO_KEY_DEMO_ENABLED (OFF by default):
// dark ⇒ key-free requests get 401 key_required, BYOK is untouched.

const DEMO_IP_PER_MINUTE = 3;
const DEMO_IP_PER_DAY = 10;
// Measured real cost of one gemini-flash classification (~0.19¢). Pre-charged
// against the daily budget BEFORE the provider call so the budget fails closed.
const DEMO_CLASSIFY_EST_USD = 0.0019;
const DEMO_CLASSIFY_COST_FRACTIONAL_CENTS = usdToFractionalCents(DEMO_CLASSIFY_EST_USD);
// Bound the per-IP map so a botnet of unique IPs can't grow it forever; stale
// (previous-day) entries are evicted once the map crosses this size.
const DEMO_IP_MAP_MAX_ENTRIES = 10_000;

interface DemoIpUsage {
  minuteKey: number;
  minuteCount: number;
  dayKey: string;
  dayCount: number;
}

const demoIpUsage = new Map<string, DemoIpUsage>();
let demoBudget = { dayKey: "", usedFractionalCents: 0 };

function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Test seam: clears the in-memory demo rate/budget ledgers between tests. */
export function _resetPlaygroundDemoState(): void {
  demoIpUsage.clear();
  demoBudget = { dayKey: "", usedFractionalCents: 0 };
}

/** Defense 1 — take one per-IP slot; false when the minute or day cap is hit. */
function takeDemoIpSlot(ip: string): boolean {
  const now = new Date();
  const minuteKey = Math.floor(now.getTime() / 60_000);
  const dayKey = utcDayKey(now);
  const prev = demoIpUsage.get(ip);
  const minuteCount = prev && prev.minuteKey === minuteKey ? prev.minuteCount : 0;
  const dayCount = prev && prev.dayKey === dayKey ? prev.dayCount : 0;
  if (minuteCount >= DEMO_IP_PER_MINUTE || dayCount >= DEMO_IP_PER_DAY) return false;
  if (demoIpUsage.size >= DEMO_IP_MAP_MAX_ENTRIES) {
    for (const [key, usage] of demoIpUsage) {
      if (usage.dayKey !== dayKey) demoIpUsage.delete(key);
    }
  }
  demoIpUsage.set(ip, {
    minuteKey,
    minuteCount: minuteCount + 1,
    dayKey,
    dayCount: dayCount + 1,
  });
  return true;
}

/** Defense 2 — pre-charge one call against the global daily demo budget. */
function takeDemoBudget(): boolean {
  const dayKey = utcDayKey(new Date());
  const used = demoBudget.dayKey === dayKey ? demoBudget.usedFractionalCents : 0;
  if (used + DEMO_CLASSIFY_COST_FRACTIONAL_CENTS > DEMO_DAILY_BUDGET_CENTS) return false;
  demoBudget = {
    dayKey,
    usedFractionalCents: used + DEMO_CLASSIFY_COST_FRACTIONAL_CENTS,
  };
  return true;
}

async function handleNoKeyDemo(request: FastifyRequest, reply: FastifyReply, body: ClassifyBody) {
  if (!PLAYGROUND_NO_KEY_DEMO_ENABLED) {
    // Feature dark (the default): behave as the old key-required playground.
    return reply.code(401).send({ error: "key_required" });
  }
  if (!takeDemoIpSlot(request.ip)) {
    return reply.code(429).send({ error: "demo_rate_limited", byokAvailable: true });
  }
  if (!takeDemoBudget()) {
    return reply.code(429).send({ error: "demo_budget_exhausted", byokAvailable: true });
  }

  let llmError: string | undefined;
  try {
    const result = await judgeEmail(
      {
        from: body.from.trim(),
        subject: body.subject.trim(),
        snippet: body.snippet?.trim() || null,
        labels: [],
      },
      undefined, // no userId — same as BYOK, the per-user ledger is bypassed
      undefined,
      undefined, // no credentials — the server's env chain pays (global cost caps still apply)
      undefined, // no model override — Defense 3: pinned to the JUDGE_MODEL default
      (message) => {
        llmError = scrubKeys(message);
      },
    );

    if (result.source === "keyword-fallback") {
      // Server-side outage/quota problem, not the visitor's fault — never show
      // a keyword guess as Klorn's verdict; nudge toward BYOK instead.
      console.warn(`[PLAYGROUND_DEMO] llm did not run: ${sanitizeForLog(llmError ?? "?")}`);
      return reply.code(502).send({
        error: "The demo model didn't run — try again in a minute, or use your own API key.",
        byokAvailable: true,
      });
    }

    return reply.code(200).send({
      tier: result.tier,
      reason: result.reason,
      features: result.features,
      source: result.source,
    });
  } catch (err) {
    const message = sanitizeForLog(scrubKeys(err instanceof Error ? err.message : String(err)));
    console.warn(`[PLAYGROUND_DEMO] classify failed: ${message}`);
    return reply.code(502).send({
      error: "Demo classification failed — try again shortly, or use your own API key.",
      byokAvailable: true,
    });
  }
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
      if (!body.apiKey) {
        // Key-free → server-paid demo path (or 401 key_required while dark).
        return handleNoKeyDemo(request, reply, body);
      }
      const provider: PlaygroundProvider =
        body.provider === "gemini" || body.provider === "openai" ? body.provider : "openrouter";

      // Build credentials from the request body and pass straight through to
      // the classifier. No userId → the per-user cost ledger is bypassed; the
      // global cost gate AND the cross-request cooldown are skipped entirely
      // (playgroundOnly), so the quotaScope is just a constant label here — it
      // never participates in cooldown bucketing, so there is nothing to key on
      // the credential (and nothing to hash).
      const credentials: ProviderCredentials = {
        openRouterApiKey: provider === "openrouter" ? body.apiKey : null,
        geminiApiKey: provider === "gemini" ? body.apiKey : null,
        openAiApiKey: provider === "openai" ? body.apiKey : null,
        quotaScope: "playground",
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
        // key-shaped token AND strip control chars (the message can carry a
        // user-supplied model id) so it can't forge log entries.
        const message = sanitizeForLog(scrubKeys(err instanceof Error ? err.message : String(err)));
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
      // lands in the log pipeline. predicted/correct are enum-validated; model
      // and source are free strings, so strip control chars to block log forging.
      const fbModel = sanitizeForLog(body.model ?? "?");
      const fbSource = sanitizeForLog(body.source ?? "?");
      console.log(
        `[PLAYGROUND_FEEDBACK] predicted=${body.predictedTier} correct=${body.correctTier} ` +
          `model=${fbModel} source=${fbSource} subjectLen=${body.subject?.length ?? 0}`,
      );
      return reply.code(200).send({ ok: true });
    },
  );
}
