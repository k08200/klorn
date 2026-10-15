"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import AuthGuard from "../../components/auth-guard";
import { useAuth } from "../../lib/auth";
import { filesEnabled, homePath } from "../../lib/home";
import { FilesView } from "./files-view";

/**
 * /files — the Files tab (productization plan P12). Open only while the server
 * reports a drive source (`user.files`, FD-7); otherwise the route is dark: it
 * hands the visitor to their home and renders nothing of its own.
 */
export default function FilesPage() {
  return (
    <AuthGuard>
      <FilesGate />
    </AuthGuard>
  );
}

function FilesGate() {
  const { user } = useAuth();
  const router = useRouter();
  const enabled = filesEnabled(user);
  useEffect(() => {
    if (user && !enabled) router.replace(homePath(user));
  }, [user, enabled, router]);
  return enabled ? <FilesView /> : null;
}
