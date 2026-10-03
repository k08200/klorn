"use client";

import { useT } from "../../../lib/i18n";
import { TIMEZONES } from "../agent-mode-helpers";
import { PANEL, PRIMARY_BTN, SECTION_TITLE } from "./shared";
import { useAutomationConfig } from "./use-automation-config";
import { type UserProfile, useProfile } from "./use-profile";

/**
 * The operator profile form. `identity` shows the display name (Account &
 * billing); `locale` shows app language and timezone (Appearance & language).
 * Both save through the same `saveProfile`, exactly as the single form did.
 */
export function ProfilePanel({ fields }: { fields: "identity" | "locale" }) {
  const config = useAutomationConfig();
  const { profile, setProfile, profileSaved, saveProfile } = useProfile(config);
  const { t } = useT();

  return (
    <section className="mb-8">
      <h2 className={SECTION_TITLE}>
        {fields === "identity" ? t("settings.profile") : t("settings.language")}
      </h2>
      <div className={`${PANEL} p-5 space-y-4`}>
        {fields === "identity" && (
          <div>
            <label htmlFor="profile-name" className="block text-sm text-ink-mid mb-1">
              {t("settings.displayName")}
            </label>
            <input
              id="profile-name"
              type="text"
              value={profile.name}
              onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
              placeholder={t("settings.namePlaceholder")}
              className="w-full bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition placeholder-ink-dim"
            />
          </div>
        )}
        {fields === "locale" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="profile-lang" className="block text-sm text-ink-mid mb-1">
                {t("settings.language")}
              </label>
              <select
                id="profile-lang"
                value={profile.language}
                onChange={(e) =>
                  setProfile((p) => ({
                    ...p,
                    language: e.target.value as UserProfile["language"],
                  }))
                }
                className="w-full bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition"
              >
                {/* Language names name themselves — "English"/"한국어" do not
                      change with the picked UI locale. */}
                <option value="en">English</option>
                <option value="ko">한국어</option>
                <option value="ja">日本語</option>
                <option value="zh">中文（简体）</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
              </select>
            </div>
            <div>
              <label htmlFor="profile-tz" className="block text-sm text-ink-mid mb-1">
                {t("settings.timezone")}
              </label>
              <select
                id="profile-tz"
                value={profile.timezone}
                onChange={(e) => setProfile((p) => ({ ...p, timezone: e.target.value }))}
                className="w-full bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={saveProfile}
            className={
              profileSaved
                ? "ease-strong inline-flex min-h-10 items-center justify-center rounded-lg border border-state-ok-line bg-state-ok-bg px-4 text-sm font-medium text-state-ok-ink transition duration-150 active:scale-[0.97]"
                : PRIMARY_BTN
            }
          >
            {profileSaved ? t("settings.saved") : t("settings.saveProfile")}
          </button>
        </div>
      </div>
    </section>
  );
}
