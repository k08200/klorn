/**
 * `<html data-ready>`: "true" once the app is past boot (session and language
 * resolved, the persisted cache restored) and no query is fetching; "false"
 * while anything still loads. Screenshot specs wait on it (e2e/helpers.ts
 * `settle`) together with "no [aria-busy=true] / .skeleton on screen", instead
 * of sleeping. Mock and dev builds only — nothing reads it in production.
 */
import { useIsRestoring, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { MOCK_API } from "../config";

const ENABLED = MOCK_API || import.meta.env.DEV;

export function ReadySignal() {
  const queryClient = useQueryClient();
  const restoring = useIsRestoring();

  useEffect(() => {
    if (!ENABLED) return;
    const root = document.documentElement;
    root.dataset.ready = "false";
    const clear = () => {
      delete root.dataset.ready;
    };
    if (restoring) return clear;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      root.dataset.ready = "false";
      clearTimeout(timer);
      // Re-check after the current task: a query that just settled re-renders
      // its screen first, and a query that render enables (a dependent one)
      // has started fetching by then — so "true" never flickers in between.
      timer = setTimeout(() => {
        root.dataset.ready = String(queryClient.isFetching() === 0);
      }, 0);
    };
    update();
    const unsubscribe = queryClient.getQueryCache().subscribe(update);
    return () => {
      unsubscribe();
      clearTimeout(timer);
      clear();
    };
  }, [queryClient, restoring]);

  return null;
}
