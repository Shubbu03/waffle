import { site } from "../lib/site";
import { Brand } from "./brand";
import { DownloadLink } from "./download-link";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="flex flex-col items-start justify-between gap-7 py-9 md:flex-row md:items-center lg:py-12">
        <div>
          <p className="text-xs text-muted">Take your watchlist with you</p>
          <h2 className="mt-3 font-display text-footer leading-tight tracking-tight">
            A little waffle. <em>Wherever you go.</em>
          </h2>
        </div>
        <DownloadLink label="Get waffle for Android" />
      </div>
      <div className="grid grid-cols-1 items-center gap-2 border-t border-border py-6 md:grid-cols-footer md:gap-6">
        <div className="justify-self-start">
          <Brand compact />
        </div>
        <p className="text-xs text-muted md:justify-self-center md:text-center">
          Follow thoughtfully. Trade on your terms.
        </p>
        <nav aria-label="Footer navigation" className="flex items-center gap-6 text-xs text-muted md:justify-self-end">
          <a href={site.repositoryUrl} className="inline-flex min-h-11 items-center hover:text-foreground">
            Source code
          </a>
          <a href={site.releasesUrl} className="inline-flex min-h-11 items-center hover:text-foreground">
            Releases
          </a>
        </nav>
      </div>
    </footer>
  );
}
