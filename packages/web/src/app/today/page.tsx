"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import AuthGuard from "../../components/auth-guard";
import { useAuth } from "../../lib/auth";
import { LEGACY_HOME } from "../../lib/home";
import { TodayView } from "./today-view";

/**
 * /today — the home under UNIFIED_HOME (productization plan P6). While the
 * flag is off the route is dark: it hands the visitor to the legacy home and
 * renders nothing of its own.
 */
export default function TodayPage() {
  return (
    <AuthGuard>
      <TodayGate />
    </AuthGuard>
  );
}

function TodayGate() {
  const { user } = useAuth();
  const router = useRouter();
  const enabled = user?.unifiedHome === true;
  useEffect(() => {
    if (user && !enabled) router.replace(LEGACY_HOME);
  }, [user, enabled, router]);
  return enabled ? <TodayView /> : null;
}
