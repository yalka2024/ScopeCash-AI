import React from 'react';

/**
 * Public legal / trust pages: /security, /privacy, /terms, /ai-limitations,
 * /about. One file so we add exactly one import to App.js. No external
 * deps; shares the visual language of LandingPage.
 *
 * DRAFT STATUS: this copy replaces the previous generic scaffold's EU-first
 * AI Act / GDPR framing (wrong product, wrong jurisdiction) with US
 * contractor-product framing. It still contains bracketed placeholders
 * ([LEGAL ENTITY NAME], [STATE OF INCORPORATION], etc.) that only the
 * business owner can fill in, and the whole set needs review by a licensed
 * attorney before it is relied on for a real launch — an AI coding agent
 * cannot supply a real legal entity, jurisdiction, or counsel sign-off.
 * See TODO.md.
 */

const COLORS = {
  ink: 'hsl(210 40% 96%)',
  primary: 'hsl(263 70% 68%)',
  bg: 'hsl(222 47% 8%)',
  bgAlt: 'hsl(222 47% 13%)',
  border: 'hsl(217 33% 24%)',
  muted: 'hsl(215 20% 65%)',
};

const PLATFORM_NAME = 'ScopeCash AI';
const PLATFORM_ID = 'scopecash-ai';
const SUPPORT_EMAIL = `support@${PLATFORM_ID}.app`;
const PRIVACY_EMAIL = `privacy@${PLATFORM_ID}.app`;
const SECURITY_EMAIL = `security@${PLATFORM_ID}.app`;
// ScopeCash AI operates under an existing entity rather than its own. If the
// product is ever sold or spun out separately, this is the first thing that
// has to change — along with the Stripe account and the subprocessor DPAs.
const LEGAL_ENTITY = 'Neurohires LLC';
// STILL REQUIRED. These drive the governing-law and venue clauses, so a wrong
// value is worse than a visible placeholder: it would name a jurisdiction you
// have no presence in and could not enforce in. Set both before publishing.
const INCORPORATION_STATE = '[STATE OF INCORPORATION — Neurohires LLC]';
const GOVERNING_STATE = '[GOVERNING STATE — usually the state above, or principal place of business]';

const wrap = { maxWidth: 880, margin: '0 auto', padding: '0 1.25rem' };
const lastUpdated = 'July 2026 (DRAFT — pending counsel review, see note below)';

// Scoped link color: this dark-themed page previously let <a> tags inherit
// whatever global Dashboard.css (authored for the light authenticated app)
// happened to cascade in, which resolved to a near-invisible dark navy
// (#1b3a5c) on this page's near-black background — a real WCAG AA
// color-contrast failure caught by the axe-core scan in dashboard/a11y/.
// COLORS.primary against COLORS.bg measures 5.52:1 (AA requires 4.5:1).
const LINK_CSS = `.legal-page a { color: ${COLORS.primary}; } .legal-page a:hover { color: ${COLORS.ink}; } .legal-page a:visited { color: ${COLORS.primary}; }`;

function PageShell({ title, kicker, children, onHome, onPricing, onLogin, currentPath }) {
  return (
    <div className="legal-page" style={{ background: COLORS.bg, color: COLORS.ink, minHeight: '100vh', fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif' }}>
      <style>{LINK_CSS}</style>
      <header style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.bg, position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.9rem 1.25rem' }}>
          <a href="#" onClick={(e) => { e.preventDefault(); onHome(); }} style={{ fontWeight: 700, fontSize: '1.15rem', color: COLORS.ink, textDecoration: 'none' }}>
            {PLATFORM_NAME}
          </a>
          <nav style={{ display: 'flex', gap: '1.25rem', alignItems: 'center' }}>
            <a href="#pricing" onClick={(e) => { e.preventDefault(); onPricing(); }} style={{ textDecoration: 'none', fontSize: '0.95rem' }}>Pricing</a>
            <button type="button" onClick={onLogin} style={{ padding: '0.5rem 1rem', borderRadius: 6, border: `1px solid ${COLORS.border}`, background: COLORS.bg, color: COLORS.ink, cursor: 'pointer', fontSize: '0.9rem' }}>Sign in</button>
          </nav>
        </div>
      </header>

      <section style={{ background: COLORS.bgAlt, borderBottom: `1px solid ${COLORS.border}`, padding: '3rem 0 2rem' }}>
        <div style={wrap}>
          {kicker && <span style={{ display: 'inline-block', color: COLORS.primary, fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{kicker}</span>}
          <h1 style={{ fontSize: '2.25rem', margin: '0 0 0.5rem', color: COLORS.ink }}>{title}</h1>
          <p style={{ color: COLORS.muted, fontSize: '0.95rem', margin: 0 }}>Last updated: {lastUpdated}</p>
        </div>
      </section>

      <main style={{ ...wrap, padding: '2.5rem 1.25rem 4rem', lineHeight: 1.65, fontSize: '1rem', color: COLORS.ink }}>
        {children}
      </main>

      <footer style={{ background: COLORS.bg, borderTop: `1px solid ${COLORS.border}`, padding: '2rem 0', color: COLORS.muted, fontSize: '0.88rem' }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', padding: '0 1.25rem' }}>
          <span>© {new Date().getFullYear()} {PLATFORM_NAME}. All rights reserved.</span>
          <nav style={{ display: 'flex', gap: '1.25rem' }}>
            {currentPath !== 'security' && <a href="#security" style={{ color: COLORS.muted, textDecoration: 'none' }}>Security</a>}
            {currentPath !== 'privacy'  && <a href="#privacy"  style={{ color: COLORS.muted, textDecoration: 'none' }}>Privacy</a>}
            {currentPath !== 'terms'    && <a href="#terms"    style={{ color: COLORS.muted, textDecoration: 'none' }}>Terms</a>}
            {currentPath !== 'ai-limitations' && <a href="#ai-limitations" style={{ color: COLORS.muted, textDecoration: 'none' }}>AI limitations</a>}
            {currentPath !== 'about'    && <a href="#about"    style={{ color: COLORS.muted, textDecoration: 'none' }}>About</a>}
            <a
              href="#cookies"
              onClick={(e) => { e.preventDefault(); if (typeof window !== 'undefined' && typeof window.openCookieSettings === 'function') window.openCookieSettings(); }}
              style={{ color: COLORS.muted, textDecoration: 'none' }}
            >Cookie settings</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

const h2 = { fontSize: '1.4rem', margin: '2rem 0 0.75rem', color: COLORS.ink, borderBottom: `1px solid ${COLORS.border}`, paddingBottom: '0.4rem' };
const h3 = { fontSize: '1.1rem', margin: '1.5rem 0 0.5rem', color: COLORS.ink };
const p  = { margin: '0 0 1rem' };
const ul = { margin: '0 0 1rem', paddingLeft: '1.25rem' };
const note = { background: COLORS.bgAlt, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '1rem 1.25rem', margin: '1.25rem 0', fontSize: '0.9rem', color: COLORS.muted };
const draftNote = { ...note, border: `1px solid ${COLORS.primary}`, color: COLORS.ink };

function DraftBanner() {
  return (
    <div style={draftNote}>
      <strong>Draft — not yet reviewed by counsel.</strong> This page is a starting
      point, not a substitute for legal advice. Before relying on it: fill in
      the bracketed legal-entity and jurisdiction placeholders, and have it
      reviewed by an attorney licensed in your state.
    </div>
  );
}

/* ── /security ────────────────────────────────────────────────── */
export function SecurityPage(props) {
  return (
    <PageShell title="Security at a glance" kicker="Trust" currentPath="security" {...props}>
      <p style={p}>
        {PLATFORM_NAME} handles contract, estimate, and jobsite evidence for specialty
        contractors — documents and photos that matter to your business and your customers.
        This page is a plain-language summary of how we protect that data.
      </p>

      <h2 style={h2}>Hosting & data storage</h2>
      <ul style={ul}>
        <li>Hosted on Google Cloud Platform; region configured per deployment.</li>
        <li>Evidence and documents are stored in versioned object storage (Google Cloud Storage or an
          S3-compatible backend), never served from a public bucket — access is always through a
          signed, time-limited URL.</li>
        <li>Tenant isolation is enforced at both the application layer (every query scoped to your
          organization) and, on Postgres deployments, at the database layer via row-level security.</li>
      </ul>

      <h2 style={h2}>Encryption</h2>
      <ul style={ul}>
        <li><strong>In transit:</strong> TLS enforced on every connection.</li>
        <li><strong>At rest:</strong> sensitive fields (e.g. multi-factor authentication secrets) are
          encrypted with AES-256-GCM using application-managed keys, independent of provider-level
          disk encryption.</li>
        <li><strong>Secrets:</strong> production credentials are read from Google Secret Manager at
          runtime, not stored in environment files.</li>
      </ul>

      <h2 style={h2}>Access controls</h2>
      <ul style={ul}>
        <li>Six named roles (owner, admin, project manager, estimator, field user, viewer) with
          per-action authorization — a field crew member cannot approve a change-order packet or
          alter a commercial outcome.</li>
        <li>Multi-factor authentication (TOTP) available on every account; enrollment requires a
          verified email.</li>
        <li>Every sensitive action is written to an append-only, hash-chained audit log.</li>
      </ul>

      <h2 style={h2}>Evidence integrity</h2>
      <ul style={ul}>
        <li>Uploaded files are scanned for malware and validated against their declared type before
          storage.</li>
        <li>Every AI-generated finding must cite specific evidence with a quoted excerpt — a finding
          with no citation is discarded before it is ever saved, not shown to you as an unsupported guess.</li>
        <li>Packet approval and financial-outcome state changes are separate, role-gated actions from
          ordinary record edits.</li>
      </ul>

      <h2 style={h2}>Incident response</h2>
      <p style={p}>
        We will notify affected customers without unreasonable delay if we confirm a security incident
        involving your data, consistent with applicable state breach-notification law. Status updates
        are posted on the public status page and emailed to admin contacts.
      </p>

      <div style={note}>
        Need a vendor security questionnaire or an incident-response summary?
        Email <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>.
      </div>

      <DraftBanner />
    </PageShell>
  );
}

/* ── /privacy ─────────────────────────────────────────────────── */
export function PrivacyPage(props) {
  return (
    <PageShell title="Privacy notice" kicker="Legal" currentPath="privacy" {...props}>
      <p style={p}>
        This notice describes how {LEGAL_ENTITY}, doing business as {PLATFORM_NAME}
        {' '}("we", "us"), processes personal information as a <strong>business</strong> for
        our website visitors and account contacts, and as a <strong>service provider</strong> for
        data you upload into the platform under our Data Processing Addendum.
      </p>

      <h2 style={h2}>1. Who we are</h2>
      <p style={p}>
        {LEGAL_ENTITY}, incorporated in {INCORPORATION_STATE} — contact{' '}
        <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.
      </p>

      <h2 style={h2}>2. Categories of personal information</h2>
      <ul style={ul}>
        <li><strong>Account data:</strong> name, email, organization, role, hashed password, MFA enrollment.</li>
        <li><strong>Billing data:</strong> billing email, invoice history (held by Stripe; we receive metadata only).</li>
        <li><strong>Usage data:</strong> page views, feature interactions, error reports.</li>
        <li><strong>Jobsite and customer content you upload:</strong> contracts, estimates, photos, audio
          recordings, and messages related to your projects — which may include images or voices of your
          employees, subcontractors, or customers. You are responsible for having the appropriate consent
          from those individuals before uploading such content; see our Acceptable Use terms.</li>
      </ul>

      <h2 style={h2}>3. How we use it</h2>
      <ul style={ul}>
        <li>Providing the service — analyzing the evidence you upload, generating findings and packets.</li>
        <li>Billing and accounting.</li>
        <li>Security and abuse prevention.</li>
        <li>Product analytics, with cookie consent where required.</li>
      </ul>

      <h2 style={h2}>4. Sub-processors</h2>
      <p style={p}>We use a limited set of sub-processors:</p>
      <ul style={ul}>
        <li>Hosting and AI processing: Google Cloud Platform (including Vertex AI / Gemini for document
          and evidence analysis).</li>
        <li>Email: a transactional email provider (Resend or SendGrid).</li>
        <li>Payments: Stripe (you contract directly via Stripe Checkout).</li>
        <li>Error monitoring: Sentry.</li>
      </ul>
      <p style={p}>A current sub-processor list is available on request.</p>

      <h2 style={h2}>5. Retention</h2>
      <ul style={ul}>
        <li>Account data: until the account is deleted, then a limited window for backup recall.</li>
        <li>Billing data: as required by applicable tax and accounting law.</li>
        <li>Project, evidence, and packet data: per the retention period configured in your account;
          you may export or delete it at any time, subject to any active legal hold.</li>
      </ul>

      <h2 style={h2}>6. Your privacy rights</h2>
      <p style={p}>
        If you are a California resident, the California Consumer Privacy Act (CCPA), as amended by
        the CPRA, gives you the right to know what personal information we collect, to request
        deletion, to correct inaccurate information, and to opt out of the sale or sharing of personal
        information (<strong>we do not sell or share personal information</strong>). Residents of other
        states with comprehensive privacy laws (e.g. Virginia, Colorado, Connecticut, Utah) have similar
        rights. To exercise any of these, email <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.
      </p>

      <h2 style={h2}>7. Biometric, location, and recording consent</h2>
      <p style={p}>
        Some evidence you upload (jobsite photos, audio recordings, GPS-tagged images) may capture the
        likeness, voice, or location of employees, customers, or third parties. Several states (e.g.
        Illinois' BIPA) impose specific consent and handling requirements for biometric identifiers, and
        most states restrict recording audio without consent from at least one participant (some require
        all parties). <strong>You, not {PLATFORM_NAME}, are responsible for obtaining any consent required
        before uploading such evidence</strong> — see our Acceptable Use terms.
      </p>

      <h2 style={h2}>8. Cookies</h2>
      <p style={p}>
        We use strictly necessary cookies for session management and CSRF protection. Analytics cookies
        load only after consent via the cookie banner.
      </p>

      <div style={note}>
        Customers should sign our Data Processing Addendum — request a copy at{' '}
        <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.
      </div>

      <DraftBanner />
    </PageShell>
  );
}

/* ── /terms ───────────────────────────────────────────────────── */
export function TermsPage(props) {
  return (
    <PageShell title="Terms of service" kicker="Legal" currentPath="terms" {...props}>
      <p style={p}>
        These terms ("Terms") govern your access to and use of {PLATFORM_NAME} (the "Service"),
        provided by {LEGAL_ENTITY}. By creating an account or using the Service you agree to these
        Terms. If you are accepting on behalf of a business you confirm you have authority to bind it.
      </p>

      <h2 style={h2}>1. The service</h2>
      <p style={p}>
        {PLATFORM_NAME} helps specialty contractors document changed scope and unbilled work by
        comparing contracts and estimates against jobsite evidence, using AI-assisted analysis to
        surface findings for human review. <strong>The Service is a documentation and review tool. It
        does not provide legal, financial, or accounting advice, and it does not determine whether you
        are entitled to be paid for any work</strong> — those are business and legal decisions for you
        and, where appropriate, your own counsel.

      </p>

      <h2 style={h2}>2. Accounts</h2>
      <ul style={ul}>
        <li>You are responsible for the security of your credentials and for actions taken under your account.</li>
        <li>You must be at least 18 years old.</li>
        <li>Named seats only; you will not share login credentials across individuals.</li>
      </ul>

      <h2 style={h2}>3. Acceptable use</h2>
      <p style={p}>You will not, and will not permit others to:</p>
      <ul style={ul}>
        <li>Upload any recording, photo, or document you were not legally permitted to capture or
          possess, including recordings made without required consent under applicable state law.</li>
        <li>Use the Service to fabricate evidence, misrepresent the origin of a document, or generate a
          packet you know to contain a claim unsupported by the underlying evidence.</li>
        <li>Reverse engineer the Service except as permitted by law.</li>
        <li>Probe, scan, or test the security of the Service except under our published responsible
          disclosure process.</li>
        <li>Resell or sublicense the Service without a written agreement.</li>
      </ul>

      <h2 style={h2}>4. Fees and payment</h2>
      <ul style={ul}>
        <li>Paid plans renew automatically until cancelled. Cancel any time from the billing portal.</li>
        <li>Fees are exclusive of sales or use tax; we charge tax where required.</li>
        <li>Refunds are issued only where required by law.</li>
      </ul>

      <h2 style={h2}>5. Customer content & data</h2>
      <p style={p}>
        You retain all rights in content you upload. You grant us the limited license needed to operate
        the Service, including processing your content through our AI providers to generate findings and
        packets. Our processing of personal information on your behalf is governed by our Data
        Processing Addendum, incorporated into these Terms.
      </p>

      <h2 style={h2}>6. AI limitations</h2>
      <p style={p}>
        AI-generated findings and packets are decision support, not a final determination — see our{' '}
        <a href="#ai-limitations" onClick={(e) => { e.preventDefault(); props.onHome && window.location.assign('#ai-limitations'); }}>
          AI Limitations
        </a> page, which is incorporated into these Terms by reference. A human at your organization must
        review and approve any finding or packet before it is relied on or sent to a customer.
      </p>

      <h2 style={h2}>7. Confidentiality</h2>
      <p style={p}>
        Each party will protect the other's confidential information with at least reasonable care.
      </p>

      <h2 style={h2}>8. Warranties & disclaimers</h2>
      <p style={p}>
        The Service is provided "as is" to the maximum extent permitted by law. We disclaim implied
        warranties of merchantability, fitness for a particular purpose, and non-infringement.
        {' '}{PLATFORM_NAME} does not warrant that any finding, packet, or amount generated by the
        Service is accurate, complete, or sufficient to support a legal or contractual claim; you remain
        responsible for your own business and legal determinations.
      </p>

      <h2 style={h2}>9. Limitation of liability</h2>
      <p style={p}>
        To the maximum extent permitted by law, our aggregate liability for any claims arising out of or
        in connection with the Service is limited to the fees you paid in the twelve months preceding
        the event giving rise to the claim. Neither party is liable for indirect, special, incidental,
        or consequential damages. Nothing in these Terms limits liability that cannot be limited by law.
      </p>

      <h2 style={h2}>10. Term & termination</h2>
      <ul style={ul}>
        <li>Either party may terminate for material breach not cured within 30 days of notice.</li>
        <li>You may export your data for 30 days after termination; we will then delete it, subject to
          any active legal hold.</li>
        <li>Sections that by their nature should survive termination will do so.</li>
      </ul>

      <h2 style={h2}>11. Governing law</h2>
      <p style={p}>
        These Terms are governed by the laws of {GOVERNING_STATE}, without regard to its conflict-of-laws
        rules, and disputes are subject to the exclusive jurisdiction of the state and federal courts
        located there, without prejudice to any mandatory consumer protections in your jurisdiction.
      </p>

      <h2 style={h2}>12. Changes</h2>
      <p style={p}>
        We may update these Terms by giving 30 days' notice for material changes. Continued use of the
        Service after the effective date constitutes acceptance.
      </p>

      <div style={note}>
        Questions? Contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </div>

      <DraftBanner />
    </PageShell>
  );
}

/* ── /ai-limitations ──────────────────────────────────────────── */
export function AiLimitationsPage(props) {
  return (
    <PageShell title="AI limitations" kicker="Legal" currentPath="ai-limitations" {...props}>
      <p style={p}>
        {PLATFORM_NAME} uses Google's Gemini models (via Vertex AI) to analyze the contracts,
        estimates, and jobsite evidence you upload. This page explains what that AI does, what it
        deliberately refuses to do, and what still requires a human being to sign off.
      </p>

      <h2 style={h2}>What the AI does</h2>
      <ul style={ul}>
        <li>Extracts scope items and contract provisions from documents you upload, with page references.</li>
        <li>Describes what is visible in photos and transcribes audio recordings.</li>
        <li>Compares your original contracted scope against field evidence to surface possible
          scope-delta, contradiction, missing-evidence, or duplicate findings.</li>
      </ul>

      <h2 style={h2}>What the AI is designed to refuse</h2>
      <ul style={ul}>
        <li><strong>It will not invent a quantity, rate, or dollar amount</strong> that is not
          explicitly stated in a source document — a missing figure is left blank, not estimated.</li>
        <li><strong>It will not present an unsupported assertion as a finding.</strong> Every finding
          must cite specific evidence with a quoted excerpt; a finding with no citation is discarded in
          code before it is ever shown to you or saved — this is enforced by the software, not just
          requested of the model.</li>
        <li>It does not determine legal entitlement to payment, interpret contract law, or provide legal advice.</li>
      </ul>

      <h2 style={h2}>What still requires human review</h2>
      <ul style={ul}>
        <li>Every AI-generated finding starts in a <em>pending</em> state. A person at your organization
          must mark it supported or rejected before it can appear in a customer-facing packet.</li>
        <li>Packet approval and every step of the six-stage financial outcome ledger (identified,
          validated, submitted, approved, invoiced, collected) are separate actions restricted to
          specific roles — the AI cannot approve a packet or advance an outcome's financial stage.</li>
        <li>Rejected findings are excluded from packets automatically, but a human decides what gets rejected.</li>
      </ul>

      <h2 style={h2}>Known limitations</h2>
      <ul style={ul}>
        <li>Image and audio interpretation can be wrong, especially for low-quality, blurry, or
          ambiguous evidence — the system flags quality issues where it can, but does not catch every case.</li>
        <li>The AI has no way to independently verify that evidence you upload is authentic or that you
          had the right to capture it.</li>
        <li>Model behavior can change when the underlying Gemini model version is upgraded; every
          AI-generated record stores the exact model version that produced it for traceability.</li>
      </ul>

      <div style={note}>
        This page is incorporated by reference into our Terms of Service. Questions about a specific
        finding or packet? Contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </div>

      <DraftBanner />
    </PageShell>
  );
}

/* ── /about ───────────────────────────────────────────────────── */
export function AboutPage(props) {
  return (
    <PageShell title={`About ${PLATFORM_NAME}`} kicker="Company" currentPath="about" {...props}>
      <p style={p}>
        {PLATFORM_NAME} helps small specialty contractors document changed scope and unbilled
        work — turning jobsite photos, voice notes, and messages into source-linked, human-reviewed
        evidence packets they can put in front of a customer with confidence.
      </p>

      <h2 style={h2}>Why we exist</h2>
      <p style={p}>
        Contractors do extra work in the field constantly — and constantly under-document it. A photo
        gets taken, a voice note gets left, and by the time the invoice goes out, nobody can reconstruct
        exactly what changed from the original scope or prove it. We built {PLATFORM_NAME} so that proof
        is one upload away, and grounded in your own evidence rather than someone's memory of the job.
      </p>

      <h2 style={h2}>How we work</h2>
      <ul style={ul}>
        <li><strong>Evidence-grounded, not model-trusting.</strong> Every AI finding must cite real
          evidence with a quoted excerpt, enforced in code — not just asked of the model.</li>
        <li><strong>Human approval is a hard boundary.</strong> Packet approval and financial-outcome
          progression are separate, role-gated actions the AI cannot take on its own.</li>
        <li><strong>Honest about scope.</strong> We're a documentation tool, not a law firm or an
          accountant. Our outputs are evidence to support your own business decisions, not a substitute
          for qualified counsel.</li>
      </ul>

      <h2 style={h2}>Contact</h2>
      <ul style={ul}>
        <li>General: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></li>
        <li>Privacy requests: <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a></li>
        <li>Security disclosure: <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a></li>
      </ul>

      <div style={note}>
        Want to see {PLATFORM_NAME} in action? <a href="#pricing" onClick={(e) => { e.preventDefault(); props.onPricing(); }}>See pricing →</a>
      </div>
    </PageShell>
  );
}

export default { SecurityPage, PrivacyPage, TermsPage, AiLimitationsPage, AboutPage };
