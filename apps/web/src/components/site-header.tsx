import { GithubLogoIcon } from "@phosphor-icons/react";
import { site } from "../lib/site";
import { Brand } from "./brand";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  return (
    <header className="flex min-h-18 items-center justify-between gap-5 border-b border-border md:min-h-24 lg:min-h-28">
      <Brand />
      <nav aria-label="Main navigation" className="flex items-center gap-3 sm:gap-6">
        <a href="#features" className="hidden min-h-11 items-center text-xs hover:text-muted sm:inline-flex">
          Features
        </a>
        <a
          href={site.repositoryUrl}
          className="hidden min-h-11 items-center gap-1.5 text-xs hover:text-muted md:inline-flex"
        >
          <GithubLogoIcon size={18} aria-hidden="true" />
          GitHub
        </a>
        <ThemeToggle />
      </nav>
    </header>
  );
}
