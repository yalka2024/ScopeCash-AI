import React from 'react';

/**
 * Public legal / trust pages: /security, /privacy, /terms, /about.
 * One file so we add exactly one import to App.js. No external deps;
 * shares the visual language of LandingPage.
 *
 * Each page is a static React component fed by the constants below so
 * the generator can later swap in industry-specific copy without
 * touching the layout.
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

const wrap = { maxWidth: 880, margin: '0 auto', padding: '0 1.25rem' };
const lastUpdated = 'April 2026';

function PageShell({ title, kicker, children, onHome, onPricing, onLogin, currentPath }) {
  return (
    <div style={{ background: COLORS.bg, color: COLORS.ink, minHeight: '100vh', fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif' }}>
      <header style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.bg, position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.9rem 1.25rem' }}>
          <a href="#" onClick={(e) => { e.preventDefault(); onHome(); }} style={{ fontWeight: 700, fontSize: '1.15rem', color: COLORS.ink, textDecoration: 'none' }}>
            {PLATFORM_NAME}
          </a>
          <nav style={{ display: 'flex', gap: '1.25rem', alignItems: 'center' }}>
            <a href="#pricing" onClick={(e) => { e.preventDefault(); onPricing(); }} style={{ color: COLORS.muted, textDecoration: 'none', fontSize: '0.95rem' }}>Pricing</a>
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

/* ── /security ────────────────────────────────────────────────── */
export function SecurityPage(props) {
  return (
    <PageShell title="Security at a glance" kicker="Trust" currentPath="security" {...props}>
      <p style={p}>
        {PLATFORM_NAME} is built for buyers who can't compromise on trust.
        This page is a plain-language summary of how we protect your data.
        For the full controls catalog, request our SOC 2 report from <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>.
      </p>

      <h2 style={h2}>Hosting & data residency</h2>
      <ul style={ul}>
        <li>Primary region: Frankfurt (EU). Backups replicated to a second EU region.</li>
        <li>No customer data leaves the EU unless you explicitly enable a non-EU integration.</li>
        <li>Tenant isolation at the application layer; dedicated database on Enterprise.</li>
      </ul>

      <h2 style={h2}>Encryption</h2>
      <ul style={ul}>
        <li><strong>In transit:</strong> TLS 1.3 enforced; HSTS preload; modern cipher suite policy.</li>
        <li><strong>At rest:</strong> AES-256 with managed keys; database backups encrypted with separate key.</li>
        <li><strong>Secrets:</strong> Stored in a managed secrets vault, rotated quarterly.</li>
      </ul>

      <h2 style={h2}>Access controls</h2>
      <ul style={ul}>
        <li>SSO (SAML 2.0 / OIDC) on Pro and Enterprise.</li>
        <li>MFA enforced on all admin accounts; TOTP available for every user.</li>
        <li>Role-based access controls; least-privilege defaults.</li>
        <li>Just-in-time elevation for engineering production access; every action audit-logged.</li>
      </ul>

      <h2 style={h2}>Application security</h2>
      <ul style={ul}>
        <li>Dependencies continuously scanned (CVE feeds + SCA).</li>
        <li>Static + dynamic analysis on every build.</li>
        <li>Annual third-party penetration test; remediation SLAs published in the trust portal.</li>
        <li>Bug bounty program — coordinated disclosure at <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>.</li>
      </ul>

      <h2 style={h2}>Reliability</h2>
      <ul style={ul}>
        <li>Target uptime: 99.9% (Enterprise SLA available).</li>
        <li>Backup RPO: 24 hours. Restore RTO: 4 hours.</li>
        <li>Backups tested monthly via automated restore.</li>
      </ul>

      <h2 style={h2}>Incident response</h2>
      <p style={p}>
        We notify affected customers within 72 hours of confirming a security incident,
        in line with GDPR Article 33. Status updates are posted on the public status page
        and emailed to admin contacts.
      </p>

      <div style={note}>
        Need a vendor security questionnaire, SOC 2 report, or penetration-test summary?
        Email <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a> — typical turnaround is one business day.
      </div>

      <h2 style={h2}>Downloadable artifacts</h2>
      <ul style={ul}>
        <li><a href="/api/trust/documents/security-overview.md">Security overview (Markdown)</a></li>
        <li><a href="/api/trust/documents/security-controls.json">Security controls catalog (JSON)</a></li>
        <li><a href="/api/trust/documents/subprocessors.json">Sub-processor list (JSON)</a></li>
        <li><a href="/api/trust/documents/retention-schedule.json">Data-retention schedule (JSON)</a></li>
        <li><a href="/api/trust/pack">Full compliance pack (ZIP, signed manifest)</a></li>
      </ul>
    </PageShell>
  );
}

/* ── /privacy ─────────────────────────────────────────────────── */
export function PrivacyPage(props) {
  return (
    <PageShell title="Privacy notice" kicker="Legal" currentPath="privacy" {...props}>
      <p style={p}>
        This notice describes how {PLATFORM_NAME} ("we", "us") processes personal data
        as a <strong>controller</strong> for our website visitors and account contacts,
        and as a <strong>processor</strong> for data you upload into the platform under our
        Data Processing Addendum (DPA). It is written to satisfy GDPR Articles 13–14
        and the EU AI Act transparency expectations.
      </p>

      <h2 style={h2}>1. Controller</h2>
      <p style={p}>
        {PLATFORM_NAME} — contact <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.
        EU representative and Data Protection Officer details are available on request.
      </p>

      <h2 style={h2}>2. Categories of personal data</h2>
      <ul style={ul}>
        <li><strong>Account data:</strong> name, email, organisation, role, hashed password, MFA enrolment.</li>
        <li><strong>Billing data:</strong> billing email, VAT ID, invoice history (held by Stripe; we receive metadata only).</li>
        <li><strong>Usage data:</strong> page views, feature interactions, error reports — used to operate and improve the service.</li>
        <li><strong>Customer content:</strong> AI use case descriptions, attestations, audit-log entries — processed solely on your instructions under the DPA.</li>
      </ul>

      <h2 style={h2}>3. Purposes and legal bases</h2>
      <ul style={ul}>
        <li>Providing the service to you — performance of contract (Art. 6(1)(b)).</li>
        <li>Billing and accounting — legal obligation (Art. 6(1)(c)).</li>
        <li>Service security and abuse prevention — legitimate interests (Art. 6(1)(f)).</li>
        <li>Product analytics — legitimate interests, with cookie consent where required.</li>
      </ul>

      <h2 style={h2}>4. Data sharing</h2>
      <p style={p}>We use a limited set of sub-processors:</p>
      <ul style={ul}>
        <li>Hosting: Fly.io / Railway (EU regions only).</li>
        <li>Email: Resend (transactional only).</li>
        <li>Payments: Stripe (you contract directly via Checkout).</li>
        <li>Error monitoring: Sentry (PII redacted before transmission).</li>
      </ul>
      <p style={p}>
        A live sub-processor list with regions and DPAs is available on the trust portal.
        We will notify you 30 days before adding a new sub-processor that handles customer content.
      </p>

      <h2 style={h2}>5. International transfers</h2>
      <p style={p}>
        Customer content remains in the EU. Where a sub-processor transfers personal data
        outside the EU/EEA, we rely on Standard Contractual Clauses (Decision (EU) 2021/914)
        with supplementary measures (encryption in transit and at rest).
      </p>

      <h2 style={h2}>6. Retention</h2>
      <ul style={ul}>
        <li>Account data: until the account is deleted, then 30 days for backup recall.</li>
        <li>Billing data: 10 years (statutory accounting obligation).</li>
        <li>Audit-log entries you generate: per the EU AI Act Article 12 obligation (10 years for high-risk systems).</li>
        <li>Customer content: per the retention period configured in your account; you may export or erase at any time.</li>
      </ul>

      <h2 style={h2}>7. Your rights</h2>
      <p style={p}>
        Under GDPR you have the right to access, rectification, erasure, restriction,
        portability, and to object. To exercise any of these, email{' '}
        <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>. You may also lodge a
        complaint with your supervisory authority.
      </p>

      <h2 style={h2}>8. Cookies</h2>
      <p style={p}>
        We use strictly necessary cookies for session management and CSRF protection.
        Analytics cookies are loaded only after explicit consent via the cookie banner.
      </p>

      <div style={note}>
        Customers acting as controllers should sign our DPA — request a counter-signed
        copy at <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.
      </div>

      <h2 style={h2}>Downloadable templates</h2>
      <p style={p}>
        For procurement and vendor-risk teams, the unsigned templates referenced above
        are downloadable directly:
      </p>
      <ul style={ul}>
        <li><a href="/api/trust/documents/privacy-template.md">Privacy notice template (Markdown)</a></li>
        <li><a href="/api/trust/documents/dpa-template.md">Data Processing Addendum template (Markdown)</a></li>
        <li><a href="/api/trust/documents/ropa-template.md">Record of Processing Activities (GDPR Art. 30)</a></li>
        <li><a href="/api/trust/documents/subprocessors.json">Sub-processor list (JSON)</a></li>
        <li><a href="/api/trust/pack">Full compliance pack (ZIP, signed manifest)</a></li>
      </ul>
    </PageShell>
  );
}

/* ── /terms ───────────────────────────────────────────────────── */
export function TermsPage(props) {
  return (
    <PageShell title="Terms of service" kicker="Legal" currentPath="terms" {...props}>
      <p style={p}>
        These terms ("Terms") govern your access to and use of {PLATFORM_NAME} (the "Service").
        By creating an account or using the Service you agree to these Terms. If you are
        accepting on behalf of an organisation you confirm you have authority to bind it.
      </p>

      <h2 style={h2}>1. The service</h2>
      <p style={p}>
        {PLATFORM_NAME} provides software to help you classify, document, and monitor AI systems
        for compliance with Regulation (EU) 2024/1689 and adjacent obligations. The Service
        is a tool — it does not replace legal or technical advice.
      </p>

      <h2 style={h2}>2. Accounts</h2>
      <ul style={ul}>
        <li>You are responsible for the security of your credentials and for actions taken under your account.</li>
        <li>You must be at least 16 years old, or have parental consent.</li>
        <li>You will not share accounts; named seats only.</li>
      </ul>

      <h2 style={h2}>3. Acceptable use</h2>
      <p style={p}>You will not, and will not allow others to:</p>
      <ul style={ul}>
        <li>Reverse engineer or attempt to derive source code, except as permitted by mandatory law.</li>
        <li>Use the Service to violate law, including the EU AI Act, GDPR, or sanctions regimes.</li>
        <li>Probe, scan, or test the security of the Service except under our published bug-bounty terms.</li>
        <li>Resell or sublicense the Service without a written agreement.</li>
      </ul>

      <h2 style={h2}>4. Fees and payment</h2>
      <ul style={ul}>
        <li>Paid plans renew automatically until cancelled. Cancel at any time from the billing portal.</li>
        <li>Fees are exclusive of VAT; we charge VAT where required.</li>
        <li>Refunds are issued only where required by law.</li>
      </ul>

      <h2 style={h2}>5. Customer content & data</h2>
      <p style={p}>
        You retain all rights in content you upload. You grant us the limited licence
        needed to operate the Service. Our processing of personal data on your behalf
        is governed by the DPA, which is incorporated into these Terms.
      </p>

      <h2 style={h2}>6. Confidentiality</h2>
      <p style={p}>
        Each party will protect the other's confidential information with the same care
        it uses for its own (and at least reasonable care).
      </p>

      <h2 style={h2}>7. Warranties & disclaimers</h2>
      <p style={p}>
        The Service is provided "as is" to the maximum extent permitted by law.
        We disclaim implied warranties of merchantability, fitness for a particular purpose,
        and non-infringement. {PLATFORM_NAME} does not warrant that any classification or
        document generated by the Service is sufficient to establish compliance with any
        specific regulation; you remain responsible for your own legal determinations.
      </p>

      <h2 style={h2}>8. Limitation of liability</h2>
      <p style={p}>
        To the maximum extent permitted by law, our aggregate liability for any claims
        arising out of or in connection with the Service is limited to the fees paid by
        you in the twelve months preceding the event giving rise to the claim. Neither
        party is liable for indirect, special, incidental, or consequential damages.
        Nothing in these Terms limits liability that cannot be limited by law (including
        for fraud, gross negligence, or personal injury).
      </p>

      <h2 style={h2}>9. Term & termination</h2>
      <ul style={ul}>
        <li>Either party may terminate for material breach not cured within 30 days of notice.</li>
        <li>You may export your data for 30 days after termination; we will then delete it.</li>
        <li>Sections that by their nature should survive termination will do so.</li>
      </ul>

      <h2 style={h2}>10. Governing law</h2>
      <p style={p}>
        These Terms are governed by the laws of Ireland, and disputes are subject to the
        exclusive jurisdiction of the Irish courts, without prejudice to mandatory consumer
        protections in your country of residence.
      </p>

      <h2 style={h2}>11. Changes</h2>
      <p style={p}>
        We may update these Terms by giving 30 days' notice for material changes. Continued
        use of the Service after the effective date constitutes acceptance.
      </p>

      <div style={note}>
        Questions? Contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </div>

      <h2 style={h2}>Downloadable templates</h2>
      <p style={p}>
        For procurement teams, the unsigned templates are available directly:
      </p>
      <ul style={ul}>
        <li><a href="/api/trust/documents/tos-template.md">Terms of Service template (Markdown)</a></li>
        <li><a href="/api/trust/documents/dpa-template.md">Data Processing Addendum template (Markdown)</a></li>
        <li><a href="/api/trust/pack">Full compliance pack (ZIP, signed manifest)</a></li>
      </ul>
    </PageShell>
  );
}

/* ── /about ───────────────────────────────────────────────────── */
export function AboutPage(props) {
  return (
    <PageShell title={`About ${PLATFORM_NAME}`} kicker="Company" currentPath="about" {...props}>
      <p style={p}>
        {PLATFORM_NAME} helps AI providers and deployers operationalise the EU AI Act —
        from a first Article 6 risk classification to a fully attested Annex IV technical file
        and continuous post-market monitoring.
      </p>

      <h2 style={h2}>Why we exist</h2>
      <p style={p}>
        The EU AI Act takes full effect on 2 August 2026. Most teams shipping AI today
        do not yet have a defensible answer to "which Annex III use case is this?",
        let alone a maintained technical file. We built {PLATFORM_NAME} so that answer
        is one upload away — and stays accurate as your systems and the law evolve.
      </p>

      <h2 style={h2}>How we work</h2>
      <ul style={ul}>
        <li><strong>EU-first.</strong> Hosted in Frankfurt. GDPR and the EU AI Act are first-class concerns, not afterthoughts.</li>
        <li><strong>Audit-grade by default.</strong> Every classification, override, and attestation is hash-chained and exportable.</li>
        <li><strong>Open to scrutiny.</strong> Public trust portal, public status page, public sub-processor list.</li>
        <li><strong>Honest about scope.</strong> We're a tool, not a law firm. Our outputs are evidence to support your obligations, not a substitute for qualified counsel.</li>
      </ul>

      <h2 style={h2}>Contact</h2>
      <ul style={ul}>
        <li>General: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></li>
        <li>Privacy / GDPR requests: <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a></li>
        <li>Security disclosure: <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a></li>
      </ul>

      <div style={note}>
        Want to see {PLATFORM_NAME} in action? <a href="#pricing" onClick={(e) => { e.preventDefault(); props.onPricing(); }}>See pricing →</a>
      </div>
    </PageShell>
  );
}

export default { SecurityPage, PrivacyPage, TermsPage, AboutPage };

