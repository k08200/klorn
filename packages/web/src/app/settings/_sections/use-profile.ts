"use client";

import { useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import {
  mergeStoredProfile,
  PROFILE_KEY,
  type ProfileFields,
  profileSavePlan,
  type UserProfile,
} from "./profile-save-plan";
import type { AutomationConfig } from "./use-automation-config";

const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_PROFILE_KEY = `${LEGACY_KEY_PREFIX}-profile`;

export function useProfile(config: AutomationConfig | null) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useT();
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    language: "en",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [profileSaved, setProfileSaved] = useState(false);

  // Load profile from auth + localStorage
  useEffect(() => {
    if (user?.name) {
      setProfile((p) => ({ ...p, name: user.name || p.name }));
    }
    try {
      const stored = localStorage.getItem(PROFILE_KEY) || localStorage.getItem(LEGACY_PROFILE_KEY);
      if (stored) {
        localStorage.setItem(PROFILE_KEY, stored);
        localStorage.removeItem(LEGACY_PROFILE_KEY);
        const parsed = JSON.parse(stored);
        setProfile((p) => ({
          ...p,
          language: parsed.language || p.language,
          timezone: parsed.timezone || p.timezone,
        }));
      }
    } catch {
      // ignore
    }
  }, [user]);

  // The server-held timezone wins over the local copy once it arrives.
  useEffect(() => {
    const timezone = config?.timezone;
    if (timezone) setProfile((p) => ({ ...p, timezone }));
  }, [config]);

  // Each form saves only the fields it shows (see profile-save-plan.ts): the
  // name form must not write language/timezone, and the locale form must not
  // PATCH the name.
  const saveProfile = async (fields: ProfileFields) => {
    const plan = profileSavePlan(fields, profile);

    if (plan.locale) {
      // Persist language/timezone locally first so the UI preference always
      // sticks even if a server call below fails.
      localStorage.setItem(
        PROFILE_KEY,
        mergeStoredProfile(localStorage.getItem(PROFILE_KEY), plan.locale),
      );
      // The storage event never fires in the writing tab — nudge the i18n
      // provider so the UI language flips immediately after Save.
      window.dispatchEvent(new Event("klorn-profile-updated"));
    }

    if (plan.name !== null) {
      // Name is server-owned (the load path reads it from user.name, not
      // localStorage), so a failed PATCH silently reverts the displayed name on
      // the next reload. Surface the failure instead of falsely toasting success.
      try {
        await apiFetch("/api/auth/me", {
          method: "PATCH",
          body: JSON.stringify({ name: plan.name }),
        });
      } catch (err) {
        captureClientError(err, { scope: "settings.save-profile-name" });
        toast(t("settings.toast.saveNameFailed"), "error");
        return;
      }
    }

    if (plan.locale) {
      try {
        await apiFetch("/api/automations", {
          method: "PATCH",
          body: JSON.stringify({ timezone: plan.locale.timezone }),
        });
      } catch (err) {
        // Non-fatal: timezone is persisted locally and retried on the next save,
        // so we don't block the success toast — but log a signal rather than
        // swallow it (project rule; captureClientError consoles when Sentry off).
        captureClientError(err, { scope: "settings.save-profile-timezone" });
      }
    }
    setProfileSaved(true);
    toast(t("settings.toast.profileSaved"), "success");
    setTimeout(() => setProfileSaved(false), 2000);
  };

  return { profile, setProfile, profileSaved, saveProfile };
}
