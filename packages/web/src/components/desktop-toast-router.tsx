"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { openPathIsSafe } from "../lib/native/desktop-alerts";
import { shellKind } from "../lib/native/shell";

declare global {
  interface Window {
    /** Set inside the Windows desktop shell only: the shell calls it when the
     *  user clicks a toast (apps/desktop-win banner.rs open_script). */
    __klornOpenToast?: (path: string) => void;
  }
}

/**
 * Windows desktop shell only: a click on a Klorn toast opens its page (one
 * mail, or Today for the catch-up summary) with the app's router instead of a
 * full reload (decision N1). The shell has already brought the window back;
 * it falls back to a plain navigation while this is not mounted. Renders
 * nothing.
 */
export default function DesktopToastRouter() {
  const router = useRouter();

  useEffect(() => {
    if (shellKind() !== "tauri") return;
    const open = (path: string) => {
      // The shell checks the path too; never trust either side alone.
      if (openPathIsSafe(path)) router.push(path);
    };
    window.__klornOpenToast = open;
    return () => {
      if (window.__klornOpenToast === open) delete window.__klornOpenToast;
    };
  }, [router]);

  return null;
}
