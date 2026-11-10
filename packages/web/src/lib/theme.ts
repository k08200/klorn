"use client";

import { useEffect, useState } from "react";

/**
 * Theme selection: "system" follows the OS and live-updates on OS changes;
 * explicit choices persist. The <html> class is stamped pre-hydration by the
 * inline script in layout.tsx so the first paint is already correct — this
 * module only handles later changes.
 */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "klorn-theme";

export function readThemeChoice(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyThemeChoice(choice: ThemeChoice): void {
  const dark = choice === "dark" || (choice === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

export function setThemeChoice(choice: ThemeChoice): void {
  if (choice === "system") {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } else {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  }
  applyThemeChoice(choice);
}

/** Settings-UI hook: current choice + setter, following OS changes on "system". */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    setChoice(readThemeChoice());
  }, []);

  useEffect(() => {
    if (choice !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeChoice("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  const update = (next: ThemeChoice) => {
    setChoice(next);
    setThemeChoice(next);
  };
  return [choice, update];
}
