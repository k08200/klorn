"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";
import type { ApiAgentModeOption } from "../agent-mode-helpers";

export interface AutomationConfig {
  autonomousAgent?: boolean;
  agentMode?: string;
  agentModes?: ApiAgentModeOption[];
  agentIntervalMin?: number;
  dailyBriefing?: boolean;
  briefingTime?: string;
  alwaysAllowedTools?: string[];
  preApprovableTools?: string[];
  replyTone?: string;
  replyTones?: Array<{ tone: string; label: string; description: string }>;
  notificationLanguage?: string;
  notificationLanguages?: string[];
  autoMarkReadEnabled?: boolean;
  notifyEmailUrgent?: boolean;
  notifyMeeting?: boolean;
  notifyTaskDue?: boolean;
  notifyAgentProposal?: boolean;
  notifyDailyBriefing?: boolean;
  notifyEmailCandidate?: boolean;
  timezone?: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  proactiveActions?: boolean;
  phoneEscalationEnabled?: boolean;
  attentionMode?: string;
  autoReplyGuideline?: string | null;
  autoReplyGuidelineDefault?: string;
}

/**
 * One `/api/automations` read per mounted settings section. Sections that
 * need it call this once and hand the result to their panels, so a section
 * never issues the request twice.
 */
export function useAutomationConfig(): AutomationConfig | null {
  const [config, setConfig] = useState<AutomationConfig | null>(null);
  useEffect(() => {
    apiFetch<AutomationConfig>("/api/automations")
      .then((d) => setConfig(d))
      .catch((err) => captureClientError(err, { scope: "settings.load-automation-config" }));
  }, []);
  return config;
}
