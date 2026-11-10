import { onlineManager } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether the device believes it is online (TanStack's onlineManager, fed by
 * the OS's online/offline events). onlineManager only hears events after its
 * first subscriber, so an "offline" that fired during boot is re-read here.
 */
export function useOnline(): boolean {
  useEffect(() => {
    if (navigator.onLine === false && onlineManager.isOnline()) onlineManager.setOnline(false);
  }, []);
  return useSyncExternalStore(
    (cb) => onlineManager.subscribe(cb),
    () => onlineManager.isOnline(),
    () => true,
  );
}
