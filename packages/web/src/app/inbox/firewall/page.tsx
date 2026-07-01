"use client";

import AuthGuard from "../../../components/auth-guard";
import { FirewallBoard } from "../../../components/firewall-board";

export default function FirewallPage() {
  return (
    <AuthGuard>
      <FirewallBoard />
    </AuthGuard>
  );
}
