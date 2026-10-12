import { Features } from "./components/features";
import { Hero } from "./components/hero";
import { SiteFooter } from "./components/site-footer";
import { SiteHeader } from "./components/site-header";

export function App() {
  return (
    <>
      <a
        href="#main"
        className="fixed top-3 left-3 z-10 -translate-y-24 rounded-xl bg-accent px-5 py-3 text-accent-ink focus:translate-y-0"
      >
        Skip to content
      </a>
      <div className="mx-auto max-w-site px-4 sm:px-6 lg:px-10">
        <SiteHeader />
        <main id="main">
          <Hero />
          <Features />
        </main>
        <SiteFooter />
      </div>
    </>
  );
}
