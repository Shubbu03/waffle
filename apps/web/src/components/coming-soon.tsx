import { AndroidLogoIcon } from "@phosphor-icons/react";

export function ComingSoon() {
  return (
    <span className="inline-flex min-h-14 shrink-0 items-center justify-center gap-3 rounded-2xl bg-accent px-5 py-3.5 text-xs font-medium text-accent-ink">
      <AndroidLogoIcon size={20} aria-hidden="true" />
      Coming soon
    </span>
  );
}
