"use client";

import { useMemo, useState } from "react";
import { useT } from "../../../lib/i18n";
import { AUTO_TIME_ZONE, LAST_RESORT_TIME_ZONE } from "../../../lib/time-zone";
import {
  allTimeZones,
  COMMON_TIME_ZONES,
  filterTimeZones,
  type TimeZoneOption,
  utcOffsetLabel,
  zoneDisplayName,
} from "../../../lib/time-zone-options";
import { useDeviceTimeZone } from "../../../lib/time-zone-sync";

const FIELD =
  "w-full min-h-11 bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition";

interface TimeZonePickerProps {
  /** AUTO_TIME_ZONE or an IANA zone. */
  value: string;
  onChange: (value: string) => void;
}

/**
 * "Automatic (device)" first, then the common zones with friendly labels, then
 * every zone Intl knows — all narrowed by the search box. Each entry shows the
 * offset in force today.
 */
export function TimeZonePicker({ value, onChange }: TimeZonePickerProps) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const deviceZone = useDeviceTimeZone() ?? LAST_RESORT_TIME_ZONE;

  const { common, rest, nameFor } = useMemo(() => {
    const now = new Date();
    const names = new Map<string, string>(
      COMMON_TIME_ZONES.map((entry) => [entry.zone, t(entry.labelKey)]),
    );
    const name = (zone: string) => names.get(zone) ?? zoneDisplayName(zone);
    const option = (zone: string): TimeZoneOption => ({
      zone,
      label: `${name(zone)} (${utcOffsetLabel(zone, now)})`,
    });
    return {
      common: COMMON_TIME_ZONES.map((entry) => option(entry.zone)),
      rest: allTimeZones()
        .filter((zone) => !names.has(zone))
        .map(option),
      nameFor: name,
    };
  }, [t]);

  const shownCommon = filterTimeZones(common, query);
  const shownRest = filterTimeZones(rest, query);
  const isAuto = value === AUTO_TIME_ZONE;
  // Keep the current manual choice selectable even when the search hides it,
  // so the <select> never points at a missing option.
  const selectedHidden =
    !isAuto &&
    !shownCommon.some((o) => o.zone === value) &&
    !shownRest.some((o) => o.zone === value);
  const effectiveZone = isAuto ? deviceZone : value;
  const offset = utcOffsetLabel(effectiveZone);

  return (
    <div className="space-y-2">
      <label htmlFor="profile-tz" className="block text-sm text-ink-mid">
        {t("settings.timezone")}
      </label>
      <input
        id="profile-tz-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("settings.tz.search")}
        aria-label={t("settings.tz.search")}
        aria-controls="profile-tz"
        className={`${FIELD} placeholder-ink-dim`}
      />
      <select
        id="profile-tz"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={FIELD}
      >
        <option value={AUTO_TIME_ZONE}>
          {t("settings.tz.automatic", { zone: zoneDisplayName(deviceZone), offset })}
        </option>
        {selectedHidden && <option value={value}>{`${nameFor(value)} (${offset})`}</option>}
        {shownCommon.length > 0 && (
          <optgroup label={t("settings.tz.groupCommon")}>
            {shownCommon.map((o) => (
              <option key={o.zone} value={o.zone}>
                {o.label}
              </option>
            ))}
          </optgroup>
        )}
        {shownRest.length > 0 && (
          <optgroup label={t("settings.tz.groupAll")}>
            {shownRest.map((o) => (
              <option key={o.zone} value={o.zone}>
                {o.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <p className="text-xs text-ink-dim" aria-live="polite">
        {shownCommon.length + shownRest.length === 0
          ? t("settings.tz.noMatches", { query: query.trim() })
          : isAuto
            ? t("settings.tz.autoHint")
            : t("settings.tz.current", { zone: nameFor(value), offset })}
      </p>
    </div>
  );
}
