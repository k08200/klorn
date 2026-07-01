"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

interface ToastContextType {
  toast: (message: string, type?: Toast["type"]) => void;
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

// Success/info auto-dismiss quickly. Errors persist much longer so the user
// isn't rushed while reading a failure they may need to act on (WCAG 2.2.1).
const DEFAULT_DURATION_MS = 3500;
const ERROR_DURATION_MS = 12_000;

function toastDuration(type: Toast["type"]): number {
  return type === "error" ? ERROR_DURATION_MS : DEFAULT_DURATION_MS;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Live dismiss timers keyed by toast id, so hover can pause and dismiss can
  // cancel them. Cleared on unmount so a stale timer never fires later.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const scheduleDismiss = useCallback(
    (id: string, type: Toast["type"]) => {
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => dismiss(id), toastDuration(type));
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  // Pause-on-hover: cancel the pending timer while the pointer is over a toast.
  const pause = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message: string, type: Toast["type"] = "info") => {
      const id = Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev, { id, message, type }]);
      scheduleDismiss(id, type);
    },
    [scheduleDismiss],
  );

  // Clear every outstanding timer on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* The container is NOT itself a live region (#669): a container-level
          aria-live + aria-atomic re-announced the WHOLE stack on every change
          and competed with each toast's own role. Each ToastItem carries its
          OWN live semantics instead — role="alert"/assertive for errors,
          role="status"/polite for success/info — so only the new toast is
          announced, at the right urgency. */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none pb-safe pr-safe">
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            toast={t}
            onDismiss={() => dismiss(t.id)}
            onPause={() => pause(t.id)}
            onResume={() => scheduleDismiss(t.id, t.type)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
  onPause,
  onResume,
}: {
  toast: Toast;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const isError = toast.type === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
      className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg text-sm font-medium shadow-lg animate-slide-up ${
        toast.type === "success"
          ? "bg-green-700 text-white"
          : toast.type === "error"
            ? "bg-red-700 text-white"
            : "bg-surface-elevated text-stone-100 border border-stone-700"
      }`}
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="focus-ring -mr-1 -mt-0.5 shrink-0 rounded p-1 opacity-70 transition hover:opacity-100"
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
