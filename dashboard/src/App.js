import React, { useState, useEffect } from 'react';
import { isLoggedIn, getUser, logout, checkBetaStatus, onAuthChange } from './api';
import AuthPage from './AuthPage';
import DomainGroupPage from './DomainGroupPage';
import EvidenceUpload from './EvidenceUpload';
import EntitiesPage from './EntitiesPage';
import AgentConsolePage from './DashboardPage';
import AssistantPage from './AssistantPage';
import SettingsPage from './SettingsPage';
import TrustPage from './TrustPage';
import TenantsPage from './TenantsPage';
import AiEconomicsPage from './AiEconomicsPage';
import CompetitionEvidencePage from './CompetitionEvidencePage';
import GrowthPage from './GrowthPage';
import DataProductsPage from './DataProductsPage';
import MarketplacePage from './MarketplacePage';
import OperationsPage from './OperationsPage';
import StatusPage from './StatusPage';
import TrustPortalPage from './TrustPortalPage';
import GovernancePage from './GovernancePage';
import PricingPage from './PricingPage';
import LandingPage from './LandingPage';
import { SecurityPage, PrivacyPage, TermsPage, AiLimitationsPage, AboutPage } from './LegalPages';
import OnboardingWizard from './OnboardingWizard';
import EvaluationsPage from './EvaluationsPage';
import SetupPage from './SetupPage';
import IntegrationsPage from './IntegrationsPage';
import ToolsPage from './ToolsPage';
import HelpCenterPage from './HelpCenterPage';
import './Dashboard.css';

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
  { key: 'packets', label: 'Packets', models: ['evidencePacket'],
    description: 'Evidence packets built from approved findings, ready for customer or insurer review.' },
  { key: 'outcomes', label: 'Outcomes', models: ['commercialOutcome', 'costItem'],
    description: 'The six-stage money trail: identified, validated, submitted, approved, invoiced, collected — tracked separately, never merged.' },
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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
    if (page === 'pricing')   return <PricingPage onNavigateToAuth={nav.onLogin} />;
    if (page === 'setup')     return <SetupPage onHome={nav.onHome} onLogin={nav.onLogin} />;
    if (page === 'integrations') return <IntegrationsPage onHome={nav.onHome} />;
    if (page === 'help')      return <HelpCenterPage onHome={nav.onHome} onLogin={nav.onLogin} />;
    if (page === 'login')     return <AuthPage isBeta={isBeta} />;
    if (page === 'security') return <SecurityPage {...nav} />;
    if (page === 'privacy')  return <PrivacyPage  {...nav} />;
    if (page === 'terms')    return <TermsPage    {...nav} />;
    if (page === 'ai-limitations') return <AiLimitationsPage {...nav} />;
    if (page === 'about')    return <AboutPage    {...nav} />;
    return <LandingPage onPricing={nav.onPricing} onLogin={nav.onLogin} />;
  }

  const user = getUser();
  const isAdmin = user?.role === 'admin';
  // After login, marketing-only pages ('home', 'login') resolve to the workflow home.
  const authedPage = (page === 'home' || page === 'login') ? 'projects' : page;
  const workflowGroup = WORKFLOW_NAV.find((g) => g.key === authedPage);
  const adminGroup = ADMIN_NAV.find((g) => g.key === authedPage);

  return (
    <div className="app">
      <button type="button" className="menu-toggle" aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((v) => !v)}>
        {mobileNavOpen ? '✕' : '☰'}
      </button>
      <nav className={`sidebar${mobileNavOpen ? ' open' : ''}`}>
        <div className="sidebar-header">
          <h2>ScopeCash AI</h2>
          <p className="welcome">Welcome, {user?.name || user?.email}</p>
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
            refreshSignal={authedPage === 'evidence' ? evidenceRefresh : undefined}
            beforeSections={authedPage === 'evidence' ? (
              <EvidenceUpload onUploaded={(model) => setEvidenceRefresh((s) => ({ ...s, [model]: (s[model] || 0) + 1 }))} />
            ) : null}
          />
        )}
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
      </main>
    </div>
  );
}
