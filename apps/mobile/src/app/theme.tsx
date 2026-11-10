/**
 * Light / dark: follows the OS (prefers-color-scheme) unless the user picks
 * one in Accounts; the override is <html data-theme>. On native the system
 * bars' icon colour follows the resolved theme.
 */
import { SystemBars, SystemBarsStyle } from "@capacitor/core";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { kv } from "../platform/kv";
import { isNative } from "../platform/native";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "klorn-theme";

interface ThemeValue {
  choice: ThemeChoice;
  setChoice(choice: ThemeChoice): void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  if (!isNative()) return;
  const dark =
    choice === "dark" ||
    (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  void SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(
    () => {},
  );
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    const preset = document.documentElement.getAttribute("data-theme");
    return preset === "light" || preset === "dark" ? preset : "system";
  });

  useEffect(() => {
    void kv.getItem(KEY).then((stored) => {
      if (stored === "light" || stored === "dark") setChoiceState(stored);
    });
  }, []);

  useEffect(() => {
    applyTheme(choice);
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  const setChoice = (next: ThemeChoice) => {
    setChoiceState(next);
    if (next === "system") void kv.removeItem(KEY);
    else void kv.setItem(KEY, next);
  };

  return <ThemeContext.Provider value={{ choice, setChoice }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme outside ThemeProvider");
  return value;
}
