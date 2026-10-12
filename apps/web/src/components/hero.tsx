import { ComingSoon } from "./coming-soon";

export function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="grid items-center gap-6 py-6 md:grid-cols-2 md:gap-8 md:py-14 lg:gap-16 lg:py-24"
    >
      <div className="max-w-lg">
        <h1 id="hero-title" className="my-4 font-display text-hero leading-tight tracking-tight md:my-6">
          Follow the Whales.
          <br />
          Trade with <em>Signal.</em>
          <br />
          <span className="text-muted">Not noise.</span>
        </h1>
        <p className="max-w-md text-sm leading-relaxed text-muted md:leading-loose">
          Keep up with Solana wallets, make sense of their buys, and decide what comes next. All from your phone.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-6 md:mt-8">
          <ComingSoon />
          <a
            href="#features"
            className="inline-flex min-h-11 items-center text-xs hover:underline hover:underline-offset-4"
          >
            Meet waffle
          </a>
        </div>
      </div>
      <HeroArtwork />
    </section>
  );
}

function HeroArtwork() {
  return (
    <div
      role="img"
      aria-label="waffle's lime green mascot, with the words Watch, Review, Decide"
      className="relative isolate mx-auto flex h-hero-art-mobile w-full max-w-artwork items-center justify-center overflow-hidden rounded-3xl border border-border bg-accent-soft md:aspect-square md:h-auto md:rounded-artwork"
    >
      <div className="art-grid absolute inset-0 -z-10 opacity-45" aria-hidden="true" />
      <p className="absolute top-6 left-6 hidden text-xs text-muted md:block" aria-hidden="true">
        Trade with Signal. Not noise.
      </p>
      <div
        className="absolute aspect-square h-5/6 rounded-full border border-foreground/12 p-5 md:h-auto md:w-3/4"
        aria-hidden="true"
      >
        <div className="h-full rounded-full border border-dashed border-foreground/12" />
      </div>
      <img
        src="/waffle.png"
        alt=""
        width={750}
        height={787}
        fetchPriority="high"
        className="relative h-3/4 w-auto max-w-3/5 -rotate-9 object-contain drop-shadow-sm motion-safe:animate-mascot-in md:h-auto md:w-3/5"
      />
      <div className="absolute inset-x-0 bottom-4 flex -rotate-5 justify-center gap-2 md:bottom-1/6" aria-hidden="true">
        {["Watch.", "Review.", "Decide."].map((label, index) => (
          <span
            key={label}
            className={`rounded-lg border px-3 py-1.5 text-xs ${index === 2 ? "border-accent bg-accent text-accent-ink" : "border-border bg-surface text-foreground"}`}
          >
            {label}
          </span>
        ))}
      </div>
      <div
        className="absolute inset-x-6 bottom-6 hidden justify-between gap-3 text-xs text-muted md:flex"
        aria-hidden="true"
      >
        <span>Built for Solana</span>
        <span>Made for your pocket</span>
      </div>
    </div>
  );
}
