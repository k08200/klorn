"use client";

import { useCallback, useState } from "react";
import {
  dropUnconsentedKeys,
  forgetKey,
  loadProvider,
  loadRememberedKey,
  rememberKey,
  saveProvider,
} from "./key-storage";
import type { PlaygroundProvider } from "./models";

function browserStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Provider choice + the visitor's key, stored only when they opt in. */
export function useProviderKey() {
  const [provider, setProvider] = useState<PlaygroundProvider>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [remember, setRemember] = useState(false);

  const loadFor = useCallback((p: PlaygroundProvider) => {
    const store = browserStore();
    const saved = store ? loadRememberedKey(store, p) : null;
    setApiKey(saved ?? "");
    setRemember(saved !== null);
  }, []);

  /** On mount: restore the provider, sweep keys saved without consent. */
  const hydrate = useCallback((): PlaygroundProvider => {
    const store = browserStore();
    if (store) dropUnconsentedKeys(store);
    const p = store ? loadProvider(store) : "openrouter";
    setProvider(p);
    loadFor(p);
    return p;
  }, [loadFor]);

  const changeProvider = useCallback(
    (next: PlaygroundProvider) => {
      setProvider(next);
      const store = browserStore();
      if (store) saveProvider(store, next);
      loadFor(next);
    },
    [loadFor],
  );

  const changeKey = (next: string) => {
    setApiKey(next);
    const store = browserStore();
    if (remember && store) rememberKey(store, provider, next.trim());
  };

  const changeRemember = (next: boolean) => {
    setRemember(next);
    const store = browserStore();
    if (!store) return;
    if (next) rememberKey(store, provider, apiKey.trim());
    else forgetKey(store, provider);
  };

  return { provider, apiKey, remember, hydrate, changeKey, changeRemember, changeProvider };
}
