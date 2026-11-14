import { isEntitled } from "../billing/stripe.js";
import { decryptOptional } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { effectivePlan } from "../org/effective-tier.js";
import type { ProviderCredentials } from "../providers/index.js";
import { captureError } from "../sentry.js";
import { isCuratedModel } from "./model-catalog.js";

type UserWithKeys = {
  anthropicApiKey?: string | null;
  geminiApiKey?: string | null;
  chatModel?: string | null;
  plan?: string | null;
  role?: string | null;
};

/**
 * Decrypt one stored BYOK key, degrading to null (→ shared env key) if the
 * stored ciphertext is corrupt or pre-v1. A bad key must NOT take down
 * classification for the user: decryptToken throws deterministically on a
 * malformed value, so without this guard every email for that user would fail
 * at the credential step forever. We log + capture so the rot is visible (a
 * no-op captureError without a Sentry DSN is why the console line comes first),
 * then fall through to the env key — the same "degrade, don't die" posture
 * gmail.ts takes on a bad Google token.
 */
function safeDecrypt(
  value: string | null | undefined,
  label: string,
  userId: string,
): string | null {
  try {
    return decryptOptional(value);
  } catch (err) {
    console.warn(`[BYOK] ${label} decrypt failed — falling back to the shared env key`, err);
    captureError(err, { tags: { scope: "byok.decrypt" }, extra: { userId, key: label } });
    return null;
  }
}

/**
 * Resolve a user's bring-your-own-key provider credentials. TOTAL by design —
 * this is awaited on the firewall hot path and inside batch loops (backfill,
 * summarize, naver, github), so a throw here would abort a whole sweep, not
 * just one email. On any failure (DB blip or corrupt stored key) it logs a
 * signal and returns the shared-env fallback ({} / null keys) instead of
 * throwing. A keyless user resolves to null keys, which getProviderChain
 * routes to the shared env provider unchanged.
 */
export async function getUserLlmCredentials(userId: string): Promise<ProviderCredentials> {
  let user: UserWithKeys | null;
  try {
    // select only the BYOK columns — this runs on the firewall hot path, so
    // don't pull the whole row (tokens, hashes) per lookup; the narrow select
    // also makes the type precise (no cast) and would fail to compile if either
    // column were ever removed.
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        anthropicApiKey: true,
        geminiApiKey: true,
        chatModel: true,
        plan: true,
        role: true,
      },
    });
  } catch (err) {
    console.warn("[BYOK] user lookup failed — falling back to the shared env key", err);
    captureError(err, { tags: { scope: "byok.lookup" }, extra: { userId } });
    return {};
  }
  if (!user) return {};

  // Model CHOICE is for everyone (frontier chat model = user trust; the
  // per-user daily cost cap is the spend guard). Only a curated id counts —
  // anything else (including the legacy schema default) is treated as unset
  // and the chat surface falls back to its env default. Applied ONLY where a
  // call site opts in via useUserModel (conversational surfaces), never the
  // judge/summarize/draft/vision pins.
  const chosenModel = isCuratedModel(user.chatModel) ? (user.chatModel as string) : undefined;

  // BYOK is a subscriber-only feature: bringing your own key must not be a way
  // to use Klorn for free. When the paywall is on, a non-entitled user's stored
  // key is ignored (resolves to the shared env key, which the locked FREE tier
  // can't reach anyway). Entitled users (paid/trial/comped/admin) keep BYOK.
  // The model choice above survives either way.
  // A Klorn Teams seat counts (org/effective-tier.ts).
  if (!(await byokEntitled(userId, user))) {
    return { userModel: chosenModel };
  }

  const anthropicApiKey = safeDecrypt(user.anthropicApiKey, "anthropicApiKey", userId);
  // Legacy slot: no new Gemini keys are accepted, but a stored one keeps
  // serving until the user clears it.
  const geminiApiKey = safeDecrypt(user.geminiApiKey, "geminiApiKey", userId);
  return { anthropicApiKey, geminiApiKey, quotaScope: userId, userModel: chosenModel };
}

/**
 * Whether the user may bring their own key: the effective plan (own plan or a
 * Klorn Teams seat) is entitled. TOTAL like its caller: a failed seat lookup
 * is reported and counts as no seat, never as a throw.
 */
async function byokEntitled(
  userId: string,
  user: { plan: string | null; role: string | null },
): Promise<boolean> {
  const role = user.role ?? undefined;
  // Hot path: a seat only ever raises the plan, so an entitled own plan needs
  // no seat lookup. effective-tier: own plan
  const ownPlan = user.plan ?? "FREE";
  if (isEntitled(ownPlan, role)) return true;
  try {
    return isEntitled(await effectivePlan({ id: userId, plan: ownPlan }), role);
  } catch (err) {
    console.warn("[BYOK] seat lookup failed — treating the user as seatless", err);
    captureError(err, { tags: { scope: "byok.seat-lookup" }, extra: { userId } });
    return false;
  }
}
