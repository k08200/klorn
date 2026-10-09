"use client";

import AuthGuard from "../../../components/auth-guard";
import { FirewallBoard } from "../../../components/firewall-board";
import { HubHandoff } from "../../../components/hub-handoff";

export default function FirewallPage() {
  return (
    <AuthGuard>
      <HubHandoff>
        <FirewallBoard />
      </HubHandoff>
    </AuthGuard>
  );
}
