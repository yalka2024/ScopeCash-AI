import React, { useState, useEffect } from 'react';
import { isLoggedIn, getUser, logout, checkBetaStatus, onAuthChange } from './api';
import AuthPage from './AuthPage';
import DomainGroupPage from './DomainGroupPage';
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
      <nav className="sidebar">
        <div className="sidebar-header">
          <h2>ScopeCash AI</h2>
          <p className="welcome">Welcome, {user?.name || user?.email}</p>
        </div>
        <ul className="nav-links">
          {WORKFLOW_NAV.map((g) => (
            <li key={g.key} className={authedPage === g.key ? 'active' : ''} onClick={() => setPage(g.key)}>{g.label}</li>
          ))}
          <li className={authedPage === 'assistant' ? 'active' : ''} onClick={() => setPage('assistant')}>AI Assistant</li>

          {isAdmin && <React.Fragment>
            {ADMIN_NAV.map((g) => (
              <li key={g.key} className={authedPage === g.key ? 'active' : ''} onClick={() => setPage(g.key)}>{g.label}</li>
            ))}
            <li className={authedPage === 'competition' ? 'active' : ''} onClick={() => setPage('competition')}>Competition evidence</li>
            <li className={authedPage === 'ai-economics' ? 'active' : ''} onClick={() => setPage('ai-economics')}>AI economics</li>
            <li className={authedPage === 'evaluations' ? 'active' : ''} onClick={() => setPage('evaluations')}>AI evaluations</li>
            <li className={authedPage === 'growth' ? 'active' : ''} onClick={() => setPage('growth')}>Growth</li>
            <li className={authedPage === 'data-products' ? 'active' : ''} onClick={() => setPage('data-products')}>Data products</li>
            <li className={authedPage === 'operations' ? 'active' : ''} onClick={() => setPage('operations')}>Operations</li>
            <li className={authedPage === 'tenants' ? 'active' : ''} onClick={() => setPage('tenants')}>Tenants</li>
            <li className={authedPage === 'trust-portal' ? 'active' : ''} onClick={() => setPage('trust-portal')}>Trust portal</li>
            <li className={authedPage === 'governance' ? 'active' : ''} onClick={() => setPage('governance')}>Governance</li>
            <li className={authedPage === 'agent-console' ? 'active' : ''} onClick={() => setPage('agent-console')}>Agent console</li>
            <li className={authedPage === 'tools' ? 'active' : ''} onClick={() => setPage('tools')}>Tools</li>
            <li className={authedPage === 'all-records' ? 'active' : ''} onClick={() => setPage('all-records')}>All records (raw)</li>
          </React.Fragment>}

          <li className={authedPage === 'marketplace' ? 'active' : ''} onClick={() => setPage('marketplace')}>Marketplace</li>
          <li className={authedPage === 'security' ? 'active' : ''} onClick={() => setPage('security')}>Security</li>
          <li className={authedPage === 'status' ? 'active' : ''} onClick={() => setPage('status')}>Status</li>
          <li className={authedPage === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>Settings</li>
          <li className={authedPage === 'pricing' ? 'active' : ''} onClick={() => setPage('pricing')}>Pricing</li>
          <li className={authedPage === 'help' ? 'active' : ''} onClick={() => { window.location.hash = '#help'; setPage('help'); }}>Help centre</li>
        </ul>
        <button className="logout-btn" onClick={logout}>Sign Out</button>
      </nav>
      <main className="content">
        {(authedPage === 'projects' || authedPage === 'settings') && (
          <OnboardingWizard onNavigate={setPage} />
        )}
        {workflowGroup && <DomainGroupPage title={workflowGroup.label} description={workflowGroup.description} models={workflowGroup.models} />}
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
