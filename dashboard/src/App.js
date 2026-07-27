import React, { Suspense, lazy, useState, useEffect, useMemo } from 'react';
import { isLoggedIn, getUser, logout, checkBetaStatus, onAuthChange } from './api';
import './Dashboard.css';
// Eager: the small set of components on the critical first-paint path
// (the pre-auth landing/login screen, and 'projects' — the default
// post-login destination). Everything else is route-level code-split via
// React.lazy() below so a visitor only downloads the ~20 secondary/admin
// pages they actually navigate to, instead of one bundle containing all
// of them upfront (this was the dashboard's 800+ KB single-chunk warning
// — see TODO.md "Dashboard bundle splitting").
import AuthPage from './AuthPage';
import LandingPage from './LandingPage';
import DomainGroupPage from './DomainGroupPage';
import NotificationBell from './NotificationBell';
import OnboardingWizard from './OnboardingWizard';
// DomainGroupPage (eager, above) statically imports EntitySection from
// this same module, so Rollup can't move it into a separate chunk no
// matter what — lazy()-wrapping it here would just add a Suspense
// boundary around code that's already in the main bundle. Confirmed via
// a real build (Rollup logs exactly this when you get it wrong).
import EntitiesPage from './EntitiesPage';

const EvidenceUpload = lazy(() => import('./EvidenceUpload'));
const RateSheetTools = lazy(() => import('./RateSheetTools'));
const PacketTemplateTools = lazy(() => import('./PacketTemplateTools'));
const AgentConsolePage = lazy(() => import('./DashboardPage'));
const AssistantPage = lazy(() => import('./AssistantPage'));
const SettingsPage = lazy(() => import('./SettingsPage'));
const TrustPage = lazy(() => import('./TrustPage'));
const TenantsPage = lazy(() => import('./TenantsPage'));
const AiEconomicsPage = lazy(() => import('./AiEconomicsPage'));
const CompetitionEvidencePage = lazy(() => import('./CompetitionEvidencePage'));
const GrowthPage = lazy(() => import('./GrowthPage'));
const DataProductsPage = lazy(() => import('./DataProductsPage'));
const MarketplacePage = lazy(() => import('./MarketplacePage'));
const OperationsPage = lazy(() => import('./OperationsPage'));
const StatusPage = lazy(() => import('./StatusPage'));
const TrustPortalPage = lazy(() => import('./TrustPortalPage'));
const GovernancePage = lazy(() => import('./GovernancePage'));
const PricingPage = lazy(() => import('./PricingPage'));
// Named exports from one shared module — Vite/Rollup still dedupes these
// 5 dynamic import()s of './LegalPages' into a single chunk.
const SecurityPage = lazy(() => import('./LegalPages').then((m) => ({ default: m.SecurityPage })));
const PrivacyPage = lazy(() => import('./LegalPages').then((m) => ({ default: m.PrivacyPage })));
const TermsPage = lazy(() => import('./LegalPages').then((m) => ({ default: m.TermsPage })));
const AiLimitationsPage = lazy(() => import('./LegalPages').then((m) => ({ default: m.AiLimitationsPage })));
const AboutPage = lazy(() => import('./LegalPages').then((m) => ({ default: m.AboutPage })));
const EvaluationsPage = lazy(() => import('./EvaluationsPage'));
const SetupPage = lazy(() => import('./SetupPage'));
const IntegrationsPage = lazy(() => import('./IntegrationsPage'));
const ToolsPage = lazy(() => import('./ToolsPage'));
const HelpCenterPage = lazy(() => import('./HelpCenterPage'));

function PageLoading() {
  return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
}

/**
 * Authenticated nav IA — organized around the actual ScopeCash AI workflow
 * (a project's evidence turning into findings, packets, and tracked
 * outcomes), not a generic scaffold. Each entry maps to a DomainGroupPage
 * view over the real, tenant-scoped domain entities in ./entities.js.
 */
const WORKFLOW_NAV = [
  { key: 'projects', label: 'Projects', models: ['projectRecord'],
    description: 'The jobs you are documenting — contract value, trade, status, and the customer they belong to.' },
  { key: 'evidence', label: 'Evidence', models: ['sourceDocument', 'evidenceItem'],
    description: 'Uploaded contracts, estimates, photos, voice notes, receipts, and daily logs — the source material every finding cites.' },
  { key: 'findings', label: 'Findings', models: ['changeEvent', 'evidenceFinding', 'citation', 'scopeItem', 'contractProvision'],
    description: 'Scope baseline extracted from your contract, and the possible added/omitted/substituted work the AI surfaced against it — every assertion cited.' },
  { key: 'packets', label: 'Packets', models: ['evidencePacket', 'packetTemplate'],
    description: 'Evidence packets built from approved findings, ready for customer or insurer review, and the reusable layout templates they can be generated from.' },
  { key: 'outcomes', label: 'Outcomes', models: ['commercialOutcome', 'costItem', 'earnedRevenueEvent'],
    description: 'The six-stage money trail: identified, validated, submitted, approved, invoiced, collected — tracked separately, never merged. Earned-revenue events are ScopeCash AI’s success-fee ledger — see Settings to enable or review the agreement.' },
  { key: 'customers', label: 'Customers', models: ['customer', 'rateSheet', 'rateSheetItem', 'consentRecord', 'feedback', 'testimonial'],
    description: 'Customer records, your rate sheets, consent for photo/voice capture, and collected feedback.' },
  { key: 'agent-activity', label: 'Agent Activity', models: ['agentRunRecord'],
    description: 'Every AI pipeline run — model, cost, latency, and outcome. System-recorded, read-only.' },
];

const ADMIN_NAV = [
  { key: 'organization', label: 'Organization', models: ['organizationRecord', 'retentionLegalHold'],
    description: 'Your organization profile and any active legal holds on retained evidence.' },
];

function initialPageFromHash() {
  if (typeof window === 'undefined') return 'home';
  const h = window.location.hash;
  if (h === '#pricing')      return 'pricing';
  if (h === '#setup')        return 'setup';
  if (h === '#integrations') return 'integrations';
  if (h === '#help' || h.indexOf('#help/') === 0) return 'help';
  if (h === '#login')        return 'login';
  if (h === '#app')      return 'projects';
  if (h === '#assistant') return 'assistant';
  if (h === '#security') return 'security';
  if (h === '#privacy')  return 'privacy';
  if (h === '#terms')    return 'terms';
  if (h === '#ai-limitations') return 'ai-limitations';
  if (h === '#about')    return 'about';
  return 'home';
}

export default function App() {
  const [page, setPage] = useState(initialPageFromHash());
  const [isBeta, setIsBeta] = useState(false);
  const [authed, setAuthed] = useState(isLoggedIn());
  // Keyed by model (sourceDocument/evidenceItem) — a document upload only
  // bumps sourceDocument's signal, so only that table refetches, not both
  // on every single upload.
  const [evidenceRefresh, setEvidenceRefresh] = useState({});
  const [rateSheetRefresh, setRateSheetRefresh] = useState(0);
  const [packetTemplateRefresh, setPacketTemplateRefresh] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Must run on every render, before the `if (!authed) return` below —
  // hooks can never be conditional. Was previously declared after that
  // early return (harmless while it was the only such hook, since a signed-
  // out render then called strictly fewer hooks than a signed-in one until
  // the count actually diverged) — now genuinely fixed rather than
  // adding a second hook with the same latent bug.
  const rateSheetSignal = useMemo(() => ({ rateSheet: rateSheetRefresh, rateSheetItem: rateSheetRefresh }), [rateSheetRefresh]);
  const packetTemplateSignal = useMemo(() => ({ packetTemplate: packetTemplateRefresh }), [packetTemplateRefresh]);

  useEffect(() => {
    checkBetaStatus().then(setIsBeta);
    const off = onAuthChange(() => { setAuthed(false); setPage('home'); });
    function onHash() { setPage(initialPageFromHash()); }
    if (typeof window !== 'undefined') window.addEventListener('hashchange', onHash);
    return () => {
      off && off();
      if (typeof window !== 'undefined') window.removeEventListener('hashchange', onHash);
    };
  }, []);


  // Unauthenticated marketing surface ─────────────────────────────
  if (!authed) {
    const nav = {
      onHome:    () => setPage('home'),
      onPricing: () => setPage('pricing'),
      onLogin:   () => setPage('login'),
    };
    let unauthedContent;
    if (page === 'login')          unauthedContent = <AuthPage isBeta={isBeta} />;
    else if (page === 'pricing')   unauthedContent = <PricingPage onNavigateToAuth={nav.onLogin} />;
    else if (page === 'setup')     unauthedContent = <SetupPage onHome={nav.onHome} onLogin={nav.onLogin} />;
    else if (page === 'integrations') unauthedContent = <IntegrationsPage onHome={nav.onHome} />;
    else if (page === 'help')      unauthedContent = <HelpCenterPage onHome={nav.onHome} onLogin={nav.onLogin} />;
    else if (page === 'security')  unauthedContent = <SecurityPage {...nav} />;
    else if (page === 'privacy')   unauthedContent = <PrivacyPage  {...nav} />;
    else if (page === 'terms')     unauthedContent = <TermsPage    {...nav} />;
    else if (page === 'ai-limitations') unauthedContent = <AiLimitationsPage {...nav} />;
    else if (page === 'about')     unauthedContent = <AboutPage    {...nav} />;
    else return <LandingPage onPricing={nav.onPricing} onLogin={nav.onLogin} />;
    // LandingPage stays eager and returns directly above (the actual
    // marketing home page most anonymous visitors land on) — everything
    // else in this branch is a lazy import needing a Suspense boundary.
    return <Suspense fallback={<PageLoading />}>{unauthedContent}</Suspense>;
  }

  const user = getUser();
  const isAdmin = user?.role === 'admin';
  // After login, marketing-only pages ('home', 'login') resolve to the workflow home.
  const authedPage = (page === 'home' || page === 'login') ? 'projects' : page;
  const workflowGroup = WORKFLOW_NAV.find((g) => g.key === authedPage);
  const adminGroup = ADMIN_NAV.find((g) => g.key === authedPage);
  // One lookup instead of a growing per-page ternary chain for refreshSignal/
  // beforeSections/onSectionSaved — each entry's own widget keeps its own
  // callback shape (EvidenceUpload targets one model per upload; the
  // versioning-tools widgets bump a single flat counter), so this stays a
  // page -> config map rather than forcing every widget onto one uniform API.
  const PAGE_TOOLS = {
    evidence: {
      refreshSignal: evidenceRefresh,
      render: () => <EvidenceUpload onUploaded={(model) => setEvidenceRefresh((s) => ({ ...s, [model]: (s[model] || 0) + 1 }))} />,
    },
    customers: {
      refreshSignal: rateSheetSignal,
      render: () => <RateSheetTools reloadSignal={rateSheetRefresh} onChanged={() => setRateSheetRefresh((n) => n + 1)} />,
      onSectionSaved: (model) => { if (model === 'rateSheet') setRateSheetRefresh((n) => n + 1); },
    },
    packets: {
      refreshSignal: packetTemplateSignal,
      render: () => <PacketTemplateTools reloadSignal={packetTemplateRefresh} onChanged={() => setPacketTemplateRefresh((n) => n + 1)} />,
      onSectionSaved: (model) => { if (model === 'packetTemplate') setPacketTemplateRefresh((n) => n + 1); },
    },
  };
  const pageTools = PAGE_TOOLS[authedPage];

  return (
    <div className="app">
      <button type="button" className="menu-toggle" aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((v) => !v)}>
        {mobileNavOpen ? '✕' : '☰'}
      </button>
      <nav className={`sidebar${mobileNavOpen ? ' open' : ''}`}>
        <div className="sidebar-header flex items-start justify-between gap-2">
          <div>
            <h2>ScopeCash AI</h2>
            <p className="welcome">Welcome, {user?.name || user?.email}</p>
          </div>
          <NotificationBell />
        </div>
        {/* Event delegation, not a per-item onClick edit — closes the mobile
            drawer after picking ANY destination (a no-op click handler on
            desktop, where .sidebar never gets the .open class at all). */}
        <ul className="nav-links" onClickCapture={() => setMobileNavOpen(false)}>
          {WORKFLOW_NAV.map((g) => (
            <li key={g.key} className={authedPage === g.key ? 'active' : ''}>
              <button type="button" aria-current={authedPage === g.key ? 'page' : undefined} onClick={() => setPage(g.key)}>{g.label}</button>
            </li>
          ))}
          <li className={authedPage === 'assistant' ? 'active' : ''}>
            <button type="button" aria-current={authedPage === 'assistant' ? 'page' : undefined} onClick={() => setPage('assistant')}>AI Assistant</button>
          </li>

          {isAdmin && <React.Fragment>
            {ADMIN_NAV.map((g) => (
              <li key={g.key} className={authedPage === g.key ? 'active' : ''}>
                <button type="button" aria-current={authedPage === g.key ? 'page' : undefined} onClick={() => setPage(g.key)}>{g.label}</button>
              </li>
            ))}
            <li className={authedPage === 'competition' ? 'active' : ''}><button type="button" aria-current={authedPage === 'competition' ? 'page' : undefined} onClick={() => setPage('competition')}>Competition evidence</button></li>
            <li className={authedPage === 'ai-economics' ? 'active' : ''}><button type="button" aria-current={authedPage === 'ai-economics' ? 'page' : undefined} onClick={() => setPage('ai-economics')}>AI economics</button></li>
            <li className={authedPage === 'evaluations' ? 'active' : ''}><button type="button" aria-current={authedPage === 'evaluations' ? 'page' : undefined} onClick={() => setPage('evaluations')}>AI evaluations</button></li>
            <li className={authedPage === 'growth' ? 'active' : ''}><button type="button" aria-current={authedPage === 'growth' ? 'page' : undefined} onClick={() => setPage('growth')}>Growth</button></li>
            <li className={authedPage === 'data-products' ? 'active' : ''}><button type="button" aria-current={authedPage === 'data-products' ? 'page' : undefined} onClick={() => setPage('data-products')}>Data products</button></li>
            <li className={authedPage === 'operations' ? 'active' : ''}><button type="button" aria-current={authedPage === 'operations' ? 'page' : undefined} onClick={() => setPage('operations')}>Operations</button></li>
            <li className={authedPage === 'tenants' ? 'active' : ''}><button type="button" aria-current={authedPage === 'tenants' ? 'page' : undefined} onClick={() => setPage('tenants')}>Tenants</button></li>
            <li className={authedPage === 'trust-portal' ? 'active' : ''}><button type="button" aria-current={authedPage === 'trust-portal' ? 'page' : undefined} onClick={() => setPage('trust-portal')}>Trust portal</button></li>
            <li className={authedPage === 'governance' ? 'active' : ''}><button type="button" aria-current={authedPage === 'governance' ? 'page' : undefined} onClick={() => setPage('governance')}>Governance</button></li>
            <li className={authedPage === 'agent-console' ? 'active' : ''}><button type="button" aria-current={authedPage === 'agent-console' ? 'page' : undefined} onClick={() => setPage('agent-console')}>Agent console</button></li>
            <li className={authedPage === 'tools' ? 'active' : ''}><button type="button" aria-current={authedPage === 'tools' ? 'page' : undefined} onClick={() => setPage('tools')}>Tools</button></li>
            <li className={authedPage === 'all-records' ? 'active' : ''}><button type="button" aria-current={authedPage === 'all-records' ? 'page' : undefined} onClick={() => setPage('all-records')}>All records (raw)</button></li>
          </React.Fragment>}

          <li className={authedPage === 'marketplace' ? 'active' : ''}><button type="button" aria-current={authedPage === 'marketplace' ? 'page' : undefined} onClick={() => setPage('marketplace')}>Marketplace</button></li>
          <li className={authedPage === 'security' ? 'active' : ''}><button type="button" aria-current={authedPage === 'security' ? 'page' : undefined} onClick={() => setPage('security')}>Security</button></li>
          <li className={authedPage === 'status' ? 'active' : ''}><button type="button" aria-current={authedPage === 'status' ? 'page' : undefined} onClick={() => setPage('status')}>Status</button></li>
          <li className={authedPage === 'settings' ? 'active' : ''}><button type="button" aria-current={authedPage === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}>Settings</button></li>
          <li className={authedPage === 'pricing' ? 'active' : ''}><button type="button" aria-current={authedPage === 'pricing' ? 'page' : undefined} onClick={() => setPage('pricing')}>Pricing</button></li>
          <li className={authedPage === 'help' ? 'active' : ''}><button type="button" aria-current={authedPage === 'help' ? 'page' : undefined} onClick={() => { window.location.hash = '#help'; setPage('help'); }}>Help centre</button></li>
        </ul>
        <button className="logout-btn" onClick={logout}>Sign Out</button>
      </nav>
      <main className="content">
        {(authedPage === 'projects' || authedPage === 'settings') && (
          <OnboardingWizard onNavigate={setPage} />
        )}
        {workflowGroup && (
          <DomainGroupPage
            title={workflowGroup.label} description={workflowGroup.description} models={workflowGroup.models}
            refreshSignal={pageTools?.refreshSignal}
            beforeSections={pageTools?.render ? <Suspense fallback={<PageLoading />}>{pageTools.render()}</Suspense> : null}
            onSectionSaved={pageTools?.onSectionSaved}
          />
        )}
        {/* Everything below is a lazily-imported page component — one
            Suspense boundary covers the whole set since at most one of
            these conditions is ever true at a time. */}
        <Suspense fallback={<PageLoading />}>
          {authedPage === 'assistant' && <AssistantPage />}

          {isAdmin && adminGroup && <DomainGroupPage title={adminGroup.label} description={adminGroup.description} models={adminGroup.models} />}
          {authedPage === 'competition' && isAdmin && <CompetitionEvidencePage />}
          {authedPage === 'ai-economics' && isAdmin && <AiEconomicsPage />}
          {authedPage === 'evaluations' && isAdmin && <EvaluationsPage />}
          {authedPage === 'growth' && isAdmin && <GrowthPage />}
          {authedPage === 'data-products' && isAdmin && <DataProductsPage />}
          {authedPage === 'operations' && isAdmin && <OperationsPage />}
          {authedPage === 'tenants' && isAdmin && <TenantsPage />}
          {authedPage === 'trust-portal' && isAdmin && <TrustPortalPage />}
          {authedPage === 'governance' && isAdmin && <GovernancePage />}
          {authedPage === 'agent-console' && isAdmin && <AgentConsolePage />}
          {authedPage === 'tools' && isAdmin && <ToolsPage />}
          {authedPage === 'all-records' && isAdmin && <EntitiesPage />}

          {authedPage === 'marketplace' && <MarketplacePage user={user} />}
          {authedPage === 'security' && <TrustPage />}
          {authedPage === 'status' && <StatusPage />}
          {authedPage === 'settings' && <SettingsPage />}
          {authedPage === 'pricing' && <PricingPage />}
          {authedPage === 'help' && <HelpCenterPage onHome={() => setPage('projects')} />}
        </Suspense>
      </main>
    </div>
  );
}
