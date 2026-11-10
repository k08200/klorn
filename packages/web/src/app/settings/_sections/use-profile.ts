"use client";

import { useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import {
  AUTO_TIME_ZONE,
  deviceTimeZone,
  LAST_RESORT_TIME_ZONE,
  timeZonePreferenceBody,
} from "../../../lib/time-zone";
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
  const { user, applyTimeZone } = useAuth();
  const { toast } = useToast();
  const { t } = useT();
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    language: "en",
    // Automatic until the server says the user pinned a zone.
    timezone: AUTO_TIME_ZONE,
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
        // Timezone is server-owned (mode + zone); only language is read back.
        setProfile((p) => ({ ...p, language: parsed.language || p.language }));
      }
    } catch {
      // ignore
    }
  }, [user]);

  // The server holds the choice: a pinned zone, or Automatic (device).
  useEffect(() => {
    if (!config) return;
    const timezone =
      config.timezoneMode === "MANUAL" && config.timezone ? config.timezone : AUTO_TIME_ZONE;
    setProfile((p) => ({ ...p, timezone }));
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
      const body = timeZonePreferenceBody(plan.locale.timezone, deviceTimeZone());
      try {
        if (!body) throw new Error(`invalid time zone selection: ${plan.locale.timezone}`);
        await apiFetch("/api/automations", { method: "PATCH", body: JSON.stringify(body) });
        // Mirror into the signed-in user so every rendered time switches now.
        applyTimeZone(body.timezone ?? user?.timezone ?? LAST_RESORT_TIME_ZONE, body.timezoneMode);
      } catch (err) {
        // The zone drives every rendered time and the server's schedules, so a
        // failed save is surfaced instead of toasting success.
        captureClientError(err, { scope: "settings.save-profile-timezone" });
        toast(t("settings.toast.timezoneSaveFailed"), "error");
        return;
      }
    }
    setProfileSaved(true);
    toast(t("settings.toast.profileSaved"), "success");
    setTimeout(() => setProfileSaved(false), 2000);
  };

  return { profile, setProfile, profileSaved, saveProfile };
}
