"use client";

/**
 * The `?` shortcut sheet (productization plan §3, P4). It renders the HOTKEYS
 * table itself, filtered to what is live on the current screen: an entry shows
 * only when it is enabled and a surface has mounted a handler for it, so the
 * sheet can never advertise a key that does nothing here.
 */

import { useMemo } from "react";
import {
  type HotkeyGroup,
  hotkeyCaps,
  hotkeyRegistry,
  type LiveHotkey,
  liveHotkeys,
} from "../lib/hotkeys";
import { useT } from "../lib/i18n";
import { Sheet } from "./ui/sheet";

const GROUP_ORDER: readonly HotkeyGroup[] = [
  "navigate",
  "triage",
  "lane",
  "select",
  "go",
  "general",
];

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** One row per action: legacy and flag-gated entries that share a label merge. */
function rowsOf(live: readonly LiveHotkey[], group: HotkeyGroup) {
  const rows = new Map<string, string[]>();
  for (const { def } of live) {
    if (def.group !== group) continue;
    rows.set(def.labelKey, [...(rows.get(def.labelKey) ?? []), ...def.keys]);
  }
  return [...rows.entries()].map(([labelKey, keys]) => ({ labelKey, keys }));
}

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  // Read the registry when the sheet opens: handlers mount and unmount with pages.
  const live = useMemo(
    () => (open ? liveHotkeys({ triage: true, scopes: hotkeyRegistry.activeScopes() }) : []),
    [open],
  );
  const mac = isMacPlatform();

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("keys.sheet.title")}
      description={t("keys.sheet.description")}
      closeLabel={t("keys.sheet.close")}
    >
      <div className="space-y-6">
        {GROUP_ORDER.map((group) => {
          const rows = rowsOf(live, group);
          if (rows.length === 0) return null;
          return (
            <section key={group} aria-labelledby={`shortcut-group-${group}`}>
              <h3 id={`shortcut-group-${group}`} className="mb-2 text-label text-ink-mid">
                {t(`keys.group.${group}`)}
              </h3>
              <dl className="divide-y divide-line-soft">
                {rows.map((row) => (
                  <div key={row.labelKey} className="flex items-center justify-between gap-4 py-2">
                    <dt className="text-body text-ink [word-break:keep-all]">{t(row.labelKey)}</dt>
                    <dd className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                      {row.keys.map((keys, index) => (
                        <span key={keys} className="flex items-center gap-1">
                          {index > 0 && (
                            <span className="text-caption text-ink-dim">{t("keys.sheet.or")}</span>
                          )}
                          {hotkeyCaps(keys, mac).map((cap, capIndex) => (
                            <kbd
                              // biome-ignore lint/suspicious/noArrayIndexKey: caps of one chord are positional and never reorder
                              key={`${keys}-${capIndex}`}
                              className="min-w-6 rounded-control border border-line bg-surface-raised px-1.5 py-0.5 text-center font-mono text-caption text-ink-soft"
                            >
                              {cap}
                            </kbd>
                          ))}
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </Sheet>
  );
}
