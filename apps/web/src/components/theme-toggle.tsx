import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useSyncExternalStore } from "react";
import { getTheme, subscribeTheme, toggleTheme } from "../lib/theme";

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  const Icon = theme === "dark" ? SunIcon : MoonIcon;
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl text-foreground transition-colors hover:bg-surface-muted motion-reduce:transition-none"
    >
      <Icon size={20} aria-hidden="true" />
    </button>
  );
}
