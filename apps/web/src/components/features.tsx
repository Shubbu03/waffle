import { FlaskIcon, PulseIcon, WalletIcon } from "@phosphor-icons/react";

const features = [
  {
    icon: WalletIcon,
    title: "Follow wallets",
    description: "Keep your Solana wallets and their activity in one watchlist.",
  },
  {
    icon: PulseIcon,
    title: "Review buys",
    description: "See scored PumpSwap buys and the evidence behind them.",
  },
  {
    icon: FlaskIcon,
    title: "Trade on your terms",
    description: "Try paper trades first. Approve real trades with your wallet.",
  },
] as const;

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="scroll-mt-8 border-t border-border py-9 md:py-12 lg:pb-16"
    >
      <h2 id="features-title" className="mb-6 font-display text-section leading-tight tracking-tight">
        Your watchlist, with <em>context.</em>
      </h2>
      <section
        aria-label="Main features"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Make the horizontal row keyboard-scrollable.
        tabIndex={0}
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-3 md:grid md:grid-cols-3 md:gap-4 md:overflow-visible md:pb-0"
      >
        {features.map(({ icon: Icon, title, description }) => (
          <article
            key={title}
            className="flex w-60 max-w-full flex-none snap-start flex-col items-start rounded-card border border-border bg-surface p-5 md:w-auto"
          >
            <div className="mb-4 grid size-10 place-items-center rounded-xl bg-accent-soft">
              <Icon size={20} aria-hidden="true" />
            </div>
            <h3 className="text-sm font-medium">{title}</h3>
            <p className="mt-2 text-xs leading-relaxed text-muted">{description}</p>
          </article>
        ))}
      </section>
    </section>
  );
}
