import { AndroidLogoIcon } from "@phosphor-icons/react";
import { site } from "../lib/site";

export function DownloadLink({ label = "Download APK" }: { label?: string }) {
  return (
    <a
      href={site.apkUrl}
      className="inline-flex min-h-14 shrink-0 items-center justify-center gap-3 rounded-2xl bg-accent px-5 py-3.5 text-xs font-medium text-accent-ink transition-transform hover:-translate-y-0.5 motion-reduce:transform-none motion-reduce:transition-none"
    >
      <AndroidLogoIcon size={20} aria-hidden="true" />
      {label}
    </a>
  );
}
