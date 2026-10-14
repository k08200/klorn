"use client";

/**
 * How much Klorn does without asking, in one line, linking to where it is
 * changed. Agent mode (SHADOW / SUGGEST / AUTO) is delegation — not a lane,
 * and not the retired AUTO lane (docs/product-vocabulary.md).
 */

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";
import type { AutomationConfig } from "../../settings/_sections/use-automation-config";
import { type AgentMode, normalizeAgentMode } from "../../settings/agent-mode-helpers";
import { Chevron } from "../../today/block";

const SETTINGS_HREF = "/settings/assistant";
const STALE_MS = 60_000;

const MODE_KEYS: ReadonlyMap<AgentMode, { name: string; does: string }> = new Map([
  ["SHADOW", { name: "assistantHub.mode.shadow", does: "assistantHub.mode.shadow.does" }],
  ["SUGGEST", { name: "assistantHub.mode.suggest", does: "assistantHub.mode.suggest.does" }],
  ["AUTO", { name: "assistantHub.mode.auto", does: "assistantHub.mode.auto.does" }],
]);

export function AgentModeLine() {
  const { t } = useT();
  const query = useQuery({
    queryKey: queryKeys.settings.automation(),
    staleTime: STALE_MS,
    queryFn: async () => {
      try {
        return await apiFetch<AutomationConfig>("/api/automations");
      } catch (err) {
        captureClientError(err, { scope: "assistant.approvals.agent-mode" });
        throw err;
      }
    },
  });
  // Optional context: while it loads, or if it cannot load, the line is absent
  // rather than guessed.
  if (!query.data) return null;
  const keys = MODE_KEYS.get(normalizeAgentMode(query.data.agentMode));
  if (!keys) return null;
  return (
    <Link
      href={SETTINGS_HREF}
      className="focus-ring -mx-3 flex min-h-11 items-center gap-2 rounded-card px-3 text-body transition-colors duration-120 ease-fluid hover:bg-surface-hover"
    >
      <span className="min-w-0 flex-1 text-ink-muted [word-break:keep-all]">
        {t("assistantHub.mode.label")} <span className="font-medium text-ink">{t(keys.name)}</span>
        <span aria-hidden="true"> · </span>
        <span className="sr-only">, </span>
        {t(keys.does)}
      </span>
      <span className="text-ink-muted">
        <Chevron />
      </span>
    </Link>
  );
}
