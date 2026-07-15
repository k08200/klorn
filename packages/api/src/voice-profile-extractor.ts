/**
 * Voice Profile Extractor
 *
 * Samples the user's sent Gmail messages to learn their writing style:
 * tone, length, closing phrases, opener patterns, and key traits.
 *
 * The profile is stored in Memory (type=CONTEXT, key=voice_profile_v1)
 * and refreshed at most once every 7 days.
 *
 * Two consumers:
 *   - writer.ts → inject into email_draft generation
 *   - agent/prompt.ts → inject into send_email tool proposals
 *
 * Privacy note: email bodies are sent to the configured LLM only for
 * analysis; the raw bodies are never persisted beyond the in-flight call.
 */

import { google } from "googleapis";
import { decryptToken } from "./crypto-tokens.js";
import { prisma } from "./db.js";
import {
  asBoundedNumber,
  asEnum,
  asString,
  asStringArray,
  asUnitInterval,
} from "./llm/llm-coerce.js";
import { parseLlmJson } from "./llm/llm-json.js";
import { createCompletion, MODEL } from "./llm/openai.js";
import { remember } from "./memory.js";

const VOICE_PROFILE_KEY = "voice_profile_v1";
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SAMPLE_SIZE = 20; // messages to fetch
const MIN_BODIES = 3; // minimum bodies needed before analysis

export interface VoiceProfile {
  tone: "formal" | "casual" | "warm" | "direct" | "mixed";
  avgLengthWords: number;
  closingPhrases: string[]; // e.g. ["Best,", "Thanks!", "Regards,"]
  keyTraits: string[]; // e.g. ["concise", "uses bullet points", "includes context"]
  exampleOpeners: string[]; // e.g. ["Hope this finds you well", "Quick update:"]
  confidence: number; // 0.0-1.0, based on sample size
  sampledAt: string; // ISO timestamp
}

const TONES: readonly VoiceProfile["tone"][] = ["formal", "casual", "warm", "direct", "mixed"];

/**
 * Coerce any object — a freshly parsed LLM response OR a stored row read back —
 * into a contract-safe VoiceProfile. Building each field through the coerce
 * helpers (rather than spreading/casting) stops a hallucinated tone, a
 * stringified number, or junk keys from leaking into the stored profile and
 * downstream prompt context. Returns null when `raw` is not an object at all.
 *
 * `sampledAt` is preserved if the input carries a valid ISO string (read-back
 * of a stored row); otherwise a fresh timestamp is stamped (write path, where
 * the LLM never returns sampledAt).
 */
export function coerceVoiceProfile(raw: unknown): VoiceProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sampledAt = asString(r.sampledAt);
  return {
    tone: asEnum(r.tone, TONES, "mixed"),
    avgLengthWords: asBoundedNumber(r.avgLengthWords, 0, 100_000, 0),
    closingPhrases: asStringArray(r.closingPhrases),
    keyTraits: asStringArray(r.keyTraits),
    exampleOpeners: asStringArray(r.exampleOpeners),
    confidence: asUnitInterval(r.confidence),
    sampledAt: sampledAt || new Date().toISOString(),
  };
}

// ─── Extract (main entry point) ───────────────────────────────────────────────

/**
 * Extract and persist the voice profile for a user.
 * No-op if a fresh profile already exists.
 */
export async function extractVoiceProfile(
  userId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!options.force && (await isProfileFresh(userId))) return;

  try {
    const bodies = await fetchSentMailBodies(userId);
    if (bodies.length < MIN_BODIES) {
      console.log(`[VOICE] Not enough sent mail for user ${userId} (${bodies.length} bodies)`);
      return;
    }

    const profile = await analyzeWithLlm(bodies, userId);
    if (!profile) return;

    await remember(
      userId,
      "CONTEXT",
      VOICE_PROFILE_KEY,
      JSON.stringify(profile),
      "voice-profile-extractor",
    );
    console.log(
      `[VOICE] Profile persisted for user ${userId}: tone=${profile.tone}, confidence=${profile.confidence}`,
    );
  } catch (err) {
    console.warn("[VOICE] extractVoiceProfile failed for user", userId, err);
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getVoiceProfile(userId: string): Promise<VoiceProfile | null> {
  try {
    const mem = await prisma.memory.findUnique({
      where: { userId_type_key: { userId, type: "CONTEXT", key: VOICE_PROFILE_KEY } },
    });
    if (!mem) return null;
    // Coerce on read: a legacy/hallucinated stored row must not flow raw into
    // prompt context. Malformed JSON throws → caught → null.
    return coerceVoiceProfile(JSON.parse(mem.content));
  } catch (err) {
    console.warn("[VOICE] getVoiceProfile read failed:", err);
    return null;
  }
}

/**
 * Returns a compact prompt hint for the agent/writer to inject.
 * Returns empty string if no profile exists.
 */
export async function buildVoicePromptHint(userId: string): Promise<string> {
  const profile = await getVoiceProfile(userId);
  if (!profile || profile.confidence < 0.4) return "";

  const lines = [
    `[User's writing style — match this when drafting emails]`,
    `Tone: ${profile.tone}`,
    `Typical length: ~${profile.avgLengthWords} words`,
  ];

  if (profile.closingPhrases.length > 0) {
    lines.push(`Closing phrases: ${profile.closingPhrases.slice(0, 3).join(", ")}`);
  }
  if (profile.keyTraits.length > 0) {
    lines.push(`Key traits: ${profile.keyTraits.join(", ")}`);
  }
  if (profile.exampleOpeners.length > 0) {
    lines.push(`Example openers: "${profile.exampleOpeners[0]}"`);
  }

  return lines.join("\n");
}

// ─── Gmail helpers ────────────────────────────────────────────────────────────

async function fetchSentMailBodies(userId: string): Promise<string[]> {
  const token = await prisma.userToken.findUnique({
    where: { userId_provider: { userId, provider: "google" } },
    select: { accessToken: true, refreshToken: true },
  });
  if (!token?.refreshToken) return [];

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || "",
    process.env.GOOGLE_CLIENT_SECRET || "",
    process.env.GOOGLE_REDIRECT_URI || "",
  );

  let refreshToken: string;
  try {
    refreshToken = decryptToken(token.refreshToken);
  } catch (err) {
    // Log the message only — never the raw error, so token ciphertext can never
    // leak into logs even if decryptToken's error shape changes (CASA Tier 2).
    console.warn(
      "[VOICE] decryptToken failed for user — skipping sent mail sample:",
      err instanceof Error ? err.message : "decryption error",
    );
    return [];
  }

  oauth2.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  let messageIds: string[] = [];
  try {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      labelIds: ["SENT"],
      maxResults: SAMPLE_SIZE,
      q: "-category:automated -from:noreply",
    });
    messageIds = (listRes.data.messages || []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    console.warn("[VOICE] Gmail SENT list fetch failed:", err);
    return [];
  }

  const bodies = await Promise.allSettled(
    messageIds.slice(0, SAMPLE_SIZE).map(async (id) => {
      const detail = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      return extractPlainTextBody(
        detail.data as unknown as Parameters<typeof extractPlainTextBody>[0],
      );
    }),
  );

  return bodies
    .filter((r): r is PromiseFulfilledResult<string | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((b): b is string => typeof b === "string" && b.trim().length > 30);
}

function extractPlainTextBody(message: {
  payload?: {
    mimeType?: string;
    body?: { data?: string };
    parts?: unknown[];
  };
}): string | null {
  function findText(
    part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | null,
  ): string | null {
    if (!part) return null;
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8").trim();
    }
    for (const child of part.parts || []) {
      const found = findText(
        child as { mimeType?: string; body?: { data?: string }; parts?: unknown[] },
      );
      if (found) return found;
    }
    return null;
  }
  return findText(message.payload ?? null);
}

// ─── LLM analysis ─────────────────────────────────────────────────────────────

async function analyzeWithLlm(bodies: string[], userId: string): Promise<VoiceProfile | null> {
  // Cap sample to 10 messages and 300 chars each to stay under token budget
  const excerpts = bodies
    .slice(0, 10)
    .map((b, i) => `--- Email ${i + 1} ---\n${b.slice(0, 300)}`)
    .join("\n\n");

  const prompt = `Analyze the writing style from these sent email excerpts and return a JSON object only (no markdown, no explanation).

${excerpts}

Return exactly this JSON shape:
{
  "tone": "formal" | "casual" | "warm" | "direct" | "mixed",
  "avgLengthWords": <number>,
  "closingPhrases": [<string>, ...],   // max 4, actual phrases used
  "keyTraits": [<string>, ...],         // max 4, e.g. "concise", "uses bullet points"
  "exampleOpeners": [<string>, ...],    // max 3, actual opening lines
  "confidence": <0.0-1.0>               // how confident based on sample quality
}`;

  try {
    const res = await createCompletion(
      {
        model: MODEL,
        messages: [
          { role: "system", content: "You are a writing style analyst. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
      },
      { credentials: await getUserCredentials(userId), userId, priority: "background" },
    );

    const raw = res.choices[0]?.message?.content || "";
    const parsed = parseLlmJson<VoiceProfile>(raw);

    // Coerce the parsed object instead of spreading it: a hallucinated tone, a
    // stringified confidence, or extra junk keys would otherwise leak into the
    // stored profile (and downstream prompt context). Same helper guards the
    // read path so a legacy row is coerced too. parsed carries no sampledAt, so
    // coerceVoiceProfile stamps a fresh timestamp here.
    return coerceVoiceProfile(parsed);
  } catch (err) {
    console.warn("[VOICE] LLM analysis failed:", err);
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function isProfileFresh(userId: string): Promise<boolean> {
  try {
    const mem = await prisma.memory.findUnique({
      where: { userId_type_key: { userId, type: "CONTEXT", key: VOICE_PROFILE_KEY } },
      select: { updatedAt: true },
    });
    if (!mem) return false;
    return Date.now() - mem.updatedAt.getTime() < REFRESH_INTERVAL_MS;
  } catch {
    return false;
  }
}

async function getUserCredentials(userId: string) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { openRouterApiKey: true, geminiApiKey: true },
    });
    if (!user) return undefined;
    const { decryptOptional } = await import("./crypto-tokens.js");
    return {
      openRouterApiKey: user.openRouterApiKey ? decryptOptional(user.openRouterApiKey) : undefined,
      geminiApiKey: user.geminiApiKey ? decryptOptional(user.geminiApiKey) : undefined,
    };
  } catch {
    return undefined;
  }
}

// ─── Scheduler helper ─────────────────────────────────────────────────────────

/**
 * Run voice profile extraction for all users with Google connected.
 * Designed to be called from automation-scheduler at low frequency (weekly).
 */
export async function extractVoiceProfilesForAllUsers(): Promise<void> {
  try {
    const tokens = await prisma.userToken.findMany({
      where: { provider: "google" },
      select: { userId: true },
    });
    for (const { userId } of tokens) {
      try {
        await extractVoiceProfile(userId);
      } catch (err) {
        console.warn("[VOICE] extractVoiceProfile failed for user", userId, err);
        // skip individual failures silently
      }
    }
  } catch (err) {
    console.error("[VOICE] Batch extraction failed:", err);
  }
}
