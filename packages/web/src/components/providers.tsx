"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AuthProvider } from "../lib/auth";
import { I18nProvider } from "../lib/i18n";
import { initSentryClient } from "../lib/sentry";
import { ConfirmProvider } from "./confirm-dialog";
import { ToastProvider } from "./toast";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Most EVE pages re-read the same endpoint within seconds (tab
        // switches, soft navs). 30s of staleness keeps perceived speed
        // fast without serving truly stale work signals.
        staleTime: 30_000,
        // Keep cached payloads around for 5 minutes so back/forward nav
        // is instant. Background refetch on focus picks up the truth.
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: 1,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

export default function Providers({ children }: { children: React.ReactNode }) {
  // useState so the client persists across hot reloads but is created
  // exactly once per browser session.
  const [queryClient] = useState(makeQueryClient);

  useEffect(() => {
    initSentryClient();
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    const removeNextDevTools = () => {
      document
        .querySelectorAll(
          [
            "#next-logo",
            "[data-nextjs-dev-tools-button]",
            'button[aria-label="Open Next.js Dev Tools"]',
          ].join(","),
        )
        .forEach((node) => {
          node.remove();
        });
    };

    removeNextDevTools();
    const observer = new MutationObserver(removeNextDevTools);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <AuthProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </AuthProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
