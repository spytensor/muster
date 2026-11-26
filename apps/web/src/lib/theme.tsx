import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { desktop } from "./desktop";
import { pushWays } from "./profile";

export type ThemeMode = "system" | "light" | "dark";
const STORAGE_KEY = "muster.theme";
const system = matchMedia("(prefers-color-scheme: dark)");

const initial = (): ThemeMode => {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
};

const Context = createContext<{
  mode: ThemeMode;
  /** Whether what is on screen is dark right now, whichever way that was chosen. */
  dark: boolean;
  setMode(mode: ThemeMode): void;
} | null>(null);

/** Applies the chosen appearance. "system" follows the device and changes with it. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(initial);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const apply = () => {
      const on = mode === "dark" || (mode === "system" && system.matches);
      document.documentElement.classList.toggle("dark", on);
      setDark(on);
    };
    // The desktop app's window follows the choice; the device's own setting then answers "system".
    desktop?.setTheme?.(mode);
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [mode]);
  const setMode = (next: ThemeMode) => {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    setModeState(next);
    // Theirs on every device, once they are signed in.
    pushWays({ theme: next });
  };
  return <Context.Provider value={{ mode, dark, setMode }}>{children}</Context.Provider>;
}

export function useTheme() {
  const value = useContext(Context);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
