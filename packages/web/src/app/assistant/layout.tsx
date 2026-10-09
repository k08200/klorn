"use client";

import type { ReactNode } from "react";
import AuthGuard from "../../components/auth-guard";
import { HubGate } from "./hub-frame";

/**
 * /assistant — the Assistant hub (productization plan §1, P7, UNIFIED_HOME):
 * Approvals, Briefing, Activity and Chat in one place. While the flag is off
 * the whole group is dark: every page hands back to its legacy route.
 */
export default function AssistantLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <HubGate>{children}</HubGate>
    </AuthGuard>
  );
}
