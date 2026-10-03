"use client";

import type { ReactNode } from "react";
import AuthGuard from "../../../components/auth-guard";
import { SettingsShell } from "../_sections/settings-shell";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <SettingsShell>{children}</SettingsShell>
    </AuthGuard>
  );
}
