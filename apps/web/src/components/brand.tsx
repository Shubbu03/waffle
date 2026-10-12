export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a href="#top" aria-label="waffle home" className="inline-flex h-11 shrink-0 items-center">
      <span className={`relative -top-1 font-wordmark leading-none ${compact ? "text-lg" : "text-wordmark"}`}>
        waffle<span className="font-display text-muted">.</span>
      </span>
    </a>
  );
}
