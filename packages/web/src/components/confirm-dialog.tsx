"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface ConfirmContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextType>({
  confirm: () => Promise.resolve(false),
});

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    setOptions(opts);
    return new Promise((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const handleClose = (result: boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOptions(null);
  };

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {options && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] px-4">
          <div
            className="bg-stone-950 border border-stone-700 rounded-xl p-6 w-full max-w-sm animate-slide-up"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
          >
            <h3 id="confirm-dialog-title" className="font-semibold mb-2">
              {options.title}
            </h3>
            <p id="confirm-dialog-message" className="text-sm text-stone-400 mb-6">
              {options.message}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => handleClose(false)}
                className="px-4 py-2 rounded-lg text-sm text-stone-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleClose(true)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  options.danger
                    ? "bg-red-600 hover:bg-red-500 text-white"
                    : "bg-amber-300 hover:bg-amber-200 text-stone-950"
                }`}
              >
                {options.confirmLabel || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
