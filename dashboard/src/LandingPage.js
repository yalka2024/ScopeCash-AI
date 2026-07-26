import React from 'react';
import { Button } from './components/ui/button';

/**
 * LandingPage — public-facing marketing landing page (dark, matches the app).
 * Shown to unauthenticated visitors who hit the root URL (or hash !== #pricing).
 * Frames ScopeCash AI for small specialty contractors: turn jobsite evidence
 * into review-ready change-order and invoice-support packets. Styled with
 * Tailwind + the shadcn design tokens.
 */

function Header({ onPricing, onLogin }) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
        <a href="#" className="text-lg font-bold text-foreground no-underline">ScopeCash AI</a>
        <nav className="flex items-center gap-5">
          <a href="#features" className="text-sm text-muted-foreground no-underline hover:text-foreground">Features</a>
          <a href="#how" className="text-sm text-muted-foreground no-underline hover:text-foreground">How it works</a>
          <a href="#trust" className="text-sm text-muted-foreground no-underline hover:text-foreground">Trust</a>
          <a href="#pricing" onClick={(e) => { e.preventDefault(); onPricing(); }} className="text-sm text-muted-foreground no-underline hover:text-foreground">Pricing</a>
          <Button variant="outline" size="sm" onClick={onLogin}>Sign in</Button>
          <Button size="sm" onClick={onPricing}>Start free</Button>
        </nav>
      </div>
    </header>
  );
}

function Hero({ onPricing, onLogin }) {
  return (
    <section className="bg-gradient-to-b from-muted/40 to-background py-16">
      <div className="mx-auto max-w-6xl px-5 text-center">
        <span className="mb-4 inline-block rounded-full bg-primary/15 px-3 py-1 text-xs font-semibold text-primary">
          Work completed should become cash collected.
        </span>
        <h1 className="mx-auto mb-4 max-w-3xl text-4xl font-bold leading-tight text-foreground">
          {/* copy:headline:start */}Turn scattered jobsite evidence into review-ready commercial documentation.{/* copy:headline:end */}
        </h1>
        <p className="mx-auto mb-8 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          {/* copy:subhead:start */}ScopeCash AI compares your original contract, estimate, and scope against jobsite photos,
          voice notes, receipts, and daily logs — then builds source-linked, human-reviewed change-order and
          invoice-support evidence packets. Every assertion cited. Every packet approved by you.{/* copy:subhead:end */}
        </p>
        <div className="mb-10 flex flex-wrap justify-center gap-3">
          <Button size="default" className="h-12 px-6 text-base" onClick={onPricing}>Start a project audit</Button>
          <a href="#how" className="inline-flex h-12 items-center rounded-md border border-primary px-6 text-base font-semibold text-primary no-underline hover:bg-primary/10">See the evidence-to-cash workflow →</a>
          <Button variant="outline" className="h-12 px-6 text-base" onClick={onLogin}>Sign in</Button>
        </div>
        <div className="flex flex-wrap justify-center gap-6 text-sm text-muted-foreground">
          <span>✓ Built for contractors with 2–30 employees</span>
          <span>✓ Your rates only — no invented pricing</span>
          <span>✓ Human approval on every packet</span>
          <span>✓ $99 pilot audit to start</span>
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    title: 'Original-scope baseline',
    body: 'Upload your contract, estimate, and scope of work. ScopeCash AI extracts every scope item, exclusion, rate, and notice provision — citing the exact page and section for each fact, with ambiguity flagged for your review.',
  },
  {
    title: 'Evidence organized automatically',
    body: 'Photos, voice notes, messages, receipts, daily logs, and labor records are classified, deduplicated by hash, and linked to their source. Originals are immutable — nothing is ever altered or overwritten.',
  },
  {
    title: 'Scope deltas with citations',
    body: 'The platform compares documented field activity against your baseline and surfaces possible added, omitted, or substituted work — every finding linked to both the contract language and the field evidence behind it.',
  },
  {
    title: 'Pricing from your rates only',
    body: 'Cost items are calculated from your rate sheets, contract rates, and supplier invoices — quantity × unit price, with markup and tax shown transparently. Missing prices are flagged, never invented.',
  },
  {
    title: 'Proof and risk review',
    body: 'A dedicated risk pass challenges every finding: contradictory documents, missing dates, unsupported quantities, and duplicate charges are surfaced before anything reaches a packet.',
  },
  {
    title: 'Human-approved evidence packets',
    body: 'Professional PDF packets with executive summary, cost breakdown, source-linked evidence appendix, and your recorded approval. Then track submitted, approved, invoiced, and collected amounts — kept strictly separate.',
  },
];

function Features() {
  return (
    <section id="features" className="bg-background py-16">
      <div className="mx-auto max-w-6xl px-5">
        <h2 className="mb-2 text-center text-3xl font-bold text-foreground">
          Everything between "we did the work" and "we got paid"
        </h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-lg text-muted-foreground">
          Changed scope and unbilled work die in camera rolls and text threads.
          ScopeCash AI turns them into documentation a customer can actually approve.
        </p>
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-card p-6">
              <h3 className="mb-2 text-lg font-semibold text-foreground">{f.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  { n: 1, title: 'Upload one project', body: 'Original contract, estimate, and scope — plus your field evidence: photos, voice notes, messages, receipts, daily logs.' },
  { n: 2, title: 'Confirm your baseline', body: 'The AI extracts scope items, exclusions, rates, and notice provisions with exact citations. You confirm the baseline before anything is compared against it.' },
  { n: 3, title: 'Review the findings', body: 'Possible scope differences, each linked to its evidence, priced from your rates, and stress-tested for contradictions and missing proof. Accept, edit, or reject each one.' },
  { n: 4, title: 'Approve the packet, track the cash', body: 'Export a professional evidence packet after your explicit approval — then record submitted, approved, invoiced, and collected amounts as they happen.' },
];

function HowItWorks() {
  return (
    <section id="how" className="bg-muted/20 py-16">
      <div className="mx-auto max-w-6xl px-5">
        <h2 className="mb-10 text-center text-3xl font-bold text-foreground">How it works</h2>
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-xl border border-border bg-card p-6">
              <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground">{s.n}</div>
              <h3 className="mb-1 text-base font-semibold text-foreground">{s.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section id="trust" className="bg-background py-16">
      <div className="mx-auto max-w-6xl px-5">
        <h2 className="mb-2 text-center text-3xl font-bold text-foreground">
          Built to be trusted with your project evidence
        </h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-lg text-muted-foreground">
          Your documentation is your money. The platform is built so it can never be invented, altered, or overstated.
        </p>
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          {[
            { t: 'Every assertion cited', b: 'No finding ships without a link to its source evidence. Unsupported conclusions are refused, not smoothed over.' },
            { t: 'Six monetary stages, never merged', b: 'Identified, validated, submitted, approved, invoiced, collected — tracked separately, so potential is never presented as revenue.' },
            { t: 'Your data stays yours', b: 'Per-organization isolation, encryption in transit and at rest, signed evidence URLs, full export and deletion on request.' },
            { t: 'Complete audit trail', b: 'Every upload, AI analysis, review decision, approval, and outcome change is logged — including what the AI got wrong and you corrected.' },
          ].map((c) => (
            <div key={c.t} className="rounded-xl border border-border bg-muted/20 p-5">
              <h3 className="mb-1 text-base font-semibold text-foreground">{c.t}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{c.b}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          {/* text-primary measured 3.68:1 against this section's background —
              below the 4.5:1 WCAG AA minimum (caught by dashboard/a11y/).
              Inline override to a lighter shade of the same hue (5.24:1). */}
          <a href="#trust-portal" className="font-semibold no-underline hover:underline" style={{ color: '#a074e8' }}>
            Visit the public trust portal →
          </a>
        </div>
      </div>
    </section>
  );
}

function CTA({ onPricing }) {
  return (
    <section className="bg-card py-14 text-center">
      <div className="mx-auto max-w-6xl px-5">
        <h2 className="mb-3 text-2xl font-bold text-foreground">
          The work is already done. The evidence already exists.
        </h2>
        <p className="mx-auto mb-7 max-w-xl text-lg text-muted-foreground">
          Run one project through a $99 pilot audit and see what documented, review-ready
          scope changes look like — before your next payment conversation.
        </p>
        <Button className="h-12 px-7 text-base" onClick={onPricing}>Start a project audit</Button>
      </div>
    </section>
  );
}

function Footer() {
  const year = new Date().getFullYear();
  const linkCls = 'text-muted-foreground no-underline hover:text-foreground';
  return (
    <footer className="border-t border-border bg-background py-8 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5">
        {/* Growth loop: attribution badge — delete this span to opt out. */}
        <span>© {year} ScopeCash AI. All rights reserved. · <a href="https://github.com/Kryst-Investments-LLC/platform-generator" target="_blank" rel="noreferrer" className={linkCls}>Built with Kubild — generated &amp; verifiable</a></span>
        <nav className="flex flex-wrap gap-5">
          <a href="#pricing" className={linkCls}>Pricing</a>
          <a href="#help" className={linkCls}>Help centre</a>
          <a href="#security" className={linkCls}>Security</a>
          <a href="#privacy" className={linkCls}>Privacy</a>
          <a href="#terms" className={linkCls}>Terms</a>
          <a href="#about" className={linkCls}>About</a>
          <a href="#cookies" onClick={(e) => { e.preventDefault(); if (typeof window !== 'undefined' && typeof window.openCookieSettings === 'function') window.openCookieSettings(); }} className={linkCls}>Cookie settings</a>
        </nav>
      </div>
      <div className="mx-auto mt-3 max-w-6xl px-5 text-xs text-muted-foreground">
        ScopeCash AI is a documentation tool, not legal advice. It does not determine legal
        entitlement, adjust insurance claims, or send commercial claims without your explicit
        approval. Consult qualified counsel for your specific contractual rights.
      </div>
    </footer>
  );
}

export default function LandingPage({ onPricing, onLogin }) {
  const goPricing = onPricing || (() => { window.location.hash = '#pricing'; window.location.reload(); });
  const goLogin   = onLogin   || (() => { window.location.hash = '#login';   window.location.reload(); });
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header onPricing={goPricing} onLogin={goLogin} />
      <Hero    onPricing={goPricing} onLogin={goLogin} />
      <Features />
      <HowItWorks />
      <Trust />
      <CTA onPricing={goPricing} />
      <Footer />
    </div>
  );
}

