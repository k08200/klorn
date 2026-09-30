/**
 * Runtime tables behind Settings › MCP API keys for the write-tools UI (step A3
 * of docs/providers/unified-platform-plan.md). @klorn/contract is type-only, so
 * the members of its wire unions are listed here; each table is a Record over
 * the union, so a new member fails the build until it is given a label.
 */

import type {
  ApiKeyActivityOutcomeWire,
  ApiKeyActivityWire,
  ApiKeyPermissionWire,
} from "@klorn/contract";

const PERMISSION_LABEL_KEYS: Record<ApiKeyPermissionWire, string> = {
  read: "settings.apiKeys.permission.read",
  read_write: "settings.apiKeys.permission.readWrite",
};

/** The choices, in display order. Read only first: it is the default. */
export const API_KEY_PERMISSIONS = Object.keys(PERMISSION_LABEL_KEYS) as ApiKeyPermissionWire[];

export const DEFAULT_API_KEY_PERMISSION: ApiKeyPermissionWire = "read";

export function permissionLabelKey(permission: ApiKeyPermissionWire): string {
  return PERMISSION_LABEL_KEYS[permission];
}

/** Chip tint per permission. Read-write is the one that can change mail, so it is the tinted one. */
const PERMISSION_CHIP_CLASSES: Record<ApiKeyPermissionWire, string> = {
  read: "bg-surface-raised text-ink-mid",
  read_write: "bg-state-info-bg text-state-info-ink",
};

export function permissionChipClasses(permission: ApiKeyPermissionWire): string {
  return PERMISSION_CHIP_CLASSES[permission];
}

const OUTCOME_LABEL_KEYS: Record<ApiKeyActivityOutcomeWire, string> = {
  ok: "settings.apiKeys.activity.outcome.ok",
  refused: "settings.apiKeys.activity.outcome.refused",
  error: "settings.apiKeys.activity.outcome.error",
  attempted: "settings.apiKeys.activity.outcome.attempted",
};

/** Chip tint per outcome, from the state tokens (each ink is >= 4.5:1 on its own surface). */
const OUTCOME_CHIP_CLASSES: Record<ApiKeyActivityOutcomeWire, string> = {
  ok: "bg-state-ok-bg text-state-ok-ink",
  refused: "bg-state-warn-bg text-state-warn-ink",
  error: "bg-state-danger-bg text-state-danger-ink",
  attempted: "bg-surface-raised text-ink-mid",
};

export function outcomeLabelKey(outcome: ApiKeyActivityOutcomeWire): string {
  return OUTCOME_LABEL_KEYS[outcome];
}

export function outcomeChipClasses(outcome: ApiKeyActivityOutcomeWire): string {
  return OUTCOME_CHIP_CLASSES[outcome];
}

/** Tools and reasons the server may name. Anything else falls back (see below). */
const TOOL_LABEL_KEYS: Readonly<Record<string, string>> = {
  mark_read: "settings.apiKeys.activity.tool.mark_read",
  set_tier: "settings.apiKeys.activity.tool.set_tier",
};

const REASON_LABEL_KEYS: Readonly<Record<string, string>> = {
  permission_denied: "settings.apiKeys.activity.reason.permission_denied",
  rate_limited: "settings.apiKeys.activity.reason.rate_limited",
  tool_error: "settings.apiKeys.activity.reason.tool_error",
  exception: "settings.apiKeys.activity.reason.exception",
};

/** Own-property lookup, so a tool named "constructor" is unknown, not a function. */
function lookup(table: Readonly<Record<string, string>>, name: string): string | null {
  return Object.hasOwn(table, name) ? table[name] : null;
}

/** i18n key for a tool, or null for one this build has no label for (show its name). */
export function toolLabelKey(tool: string): string | null {
  return lookup(TOOL_LABEL_KEYS, tool);
}

/** i18n key for a reason code, or null when there is none or it is unknown (show nothing). */
export function reasonLabelKey(reason: string | null): string | null {
  return reason === null ? null : lookup(REASON_LABEL_KEYS, reason);
}

/** A localized date and time, or the raw value if it is not a date. Never throws. */
export function formatActivityTime(iso: string, formatter: Intl.DateTimeFormat): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatter.format(date);
}

export interface KeyedActivity {
  key: string;
  row: ApiKeyActivityWire;
}

/**
 * React keys for the rows: the row's own fields, plus an occurrence count so two
 * identical rows (same millisecond, same target) stay distinct without using the
 * array index.
 */
export function keyActivityRows(rows: readonly ApiKeyActivityWire[]): KeyedActivity[] {
  const seen: Record<string, number> = {};
  return rows.map((row) => {
    const base = [row.createdAt, row.tool, row.outcome, row.reason ?? "", row.targetId ?? ""].join(
      "|",
    );
    const occurrence = (seen[base] ?? 0) + 1;
    seen[base] = occurrence;
    return { key: `${base}#${occurrence}`, row };
  });
}
