/**
 * Which parts of the operator profile a Save writes. The profile form is
 * shown in two places since the settings split — the display name under
 * Account & billing, app language and timezone under Appearance & language —
 * and each Save must write only the fields its own form shows. Kept free of
 * React so it can be unit-tested from the api package.
 */

export const PROFILE_KEY = "klorn-profile";

export interface UserProfile {
  name: string;
  language: "en" | "ko" | "auto";
  timezone: string;
}

export type ProfileFields = "identity" | "locale";

export interface ProfileLocale {
  language: UserProfile["language"];
  timezone: string;
}

export interface ProfileSavePlan {
  /** Display name to PATCH to the server, or null to leave it alone. */
  name: string | null;
  /** Language + timezone to persist (local copy and server timezone), or null. */
  locale: ProfileLocale | null;
}

export function profileSavePlan(fields: ProfileFields, profile: UserProfile): ProfileSavePlan {
  if (fields === "identity") return { name: profile.name, locale: null };
  return { name: null, locale: { language: profile.language, timezone: profile.timezone } };
}

/**
 * The next `klorn-profile` localStorage value: the stored object with only
 * language and timezone replaced, so a locale save never rewrites anything
 * else that is stored there. Unreadable or non-object contents are discarded.
 */
export function mergeStoredProfile(stored: string | null, locale: ProfileLocale): string {
  let base: Record<string, unknown> = {};
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt local copy: start from an empty object.
    }
  }
  return JSON.stringify({ ...base, language: locale.language, timezone: locale.timezone });
}
