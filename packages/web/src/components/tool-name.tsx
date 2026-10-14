"use client";

import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { toolLabelKey } from "../lib/tool-labels";

/**
 * An agent tool's name, for display. Under UNIFIED_HOME it is the human label
 * from lib/tool-labels ("Send email"), never the tool id. With the flag off
 * the text is what these surfaces showed before P7 (the id, spelled with
 * spaces), so the flag-off screens stay as they were.
 */
export function ToolName({ toolName }: { toolName: string }) {
  const { t } = useT();
  const unified = useAuth().user?.unifiedHome === true;
  return <>{unified ? t(toolLabelKey(toolName)) : toolName.replace(/_/g, " ")}</>;
}
