import React, { useState, useEffect } from 'react';
import { isLoggedIn, getUser, logout, checkBetaStatus, onAuthChange } from './api';
import AuthPage from './AuthPage';
import DashboardPage from './DashboardPage';
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
import { SecurityPage, PrivacyPage, TermsPage, AboutPage } from './LegalPages';
import OnboardingWizard from './OnboardingWizard';



import Article6WizardPage from './Article6WizardPage';
import EvaluationsPage from './EvaluationsPage';
import SetupPage from './SetupPage';
import IntegrationsPage from './IntegrationsPage';
import EntitiesPage from './EntitiesPage';
import ToolsPage from './ToolsPage';
import HelpCenterPage from './HelpCenterPage';
import './Dashboard.css';

function initialPageFromHash() {
  if (typeof window === 'undefined') return 'home';
  const h = window.location.hash;
  if (h === '#pricing')      return 'pricing';
  if (h === '#article-6')    return 'article-6';
  if (h === '#setup')        return 'setup';
  if (h === '#integrations') return 'integrations';
  if (h === '#help' || h.indexOf('#help/') === 0) return 'help';
  if (h === '#login')        return 'login';
  if (h === '#app')      return 'dashboard';
  if (h === '#assistant') return 'assistant';
  if (h === '#security') return 'security';
  if (h === '#privacy')  return 'privacy';
  if (h === '#terms')    return 'terms';
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
    if (page === 'article-6') return <Article6WizardPage onHome={nav.onHome} />;
    if (page === 'setup')     return <SetupPage onHome={nav.onHome} onLogin={nav.onLogin} />;
    if (page === 'integrations') return <IntegrationsPage onHome={nav.onHome} />;
    if (page === 'help')      return <HelpCenterPage onHome={nav.onHome} onLogin={nav.onLogin} />;
    if (page === 'login')     return <AuthPage isBeta={isBeta} />;
    if (page === 'security') return <SecurityPage {...nav} />;
    if (page === 'privacy')  return <PrivacyPage  {...nav} />;
    if (page === 'terms')    return <TermsPage    {...nav} />;
    if (page === 'about')    return <AboutPage    {...nav} />;
    return <LandingPage onPricing={nav.onPricing} onLogin={nav.onLogin} />;
  }

  const user = getUser();
  // After login, marketing-only pages ('home', 'login') resolve to the dashboard.
  const authedPage = (page === 'home' || page === 'login') ? 'dashboard' : page;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h2>ScopeCash AI</h2>
          <p className="welcome">Welcome, {user?.name || user?.email}</p>
        </div>
        <ul className="nav-links">
          <li className={authedPage === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>Dashboard</li>
          <li className={authedPage === 'assistant' ? 'active' : ''} onClick={() => setPage('assistant')}>AI Assistant</li>

          <li className={authedPage === 'data' ? 'active' : ''} onClick={() => setPage('data')}>Data</li>

          <li className={authedPage === 'tools' ? 'active' : ''} onClick={() => setPage('tools')}>Tools</li>


          <li className={authedPage === 'trust' ? 'active' : ''} onClick={() => setPage('trust')}>Trust</li>
          {user?.role === 'admin' && (
            <li className={authedPage === 'tenants' ? 'active' : ''} onClick={() => setPage('tenants')}>Tenants</li>
          )}
          {user?.role === 'admin' && (
            <li className={authedPage === 'ai-economics' ? 'active' : ''} onClick={() => setPage('ai-economics')}>AI economics</li>
          )}
          {user?.role === 'admin' && (
            <li className={authedPage === 'evaluations' ? 'active' : ''} onClick={() => setPage('evaluations')}>AI evaluations</li>
          )}
          {user?.role === 'admin' && (
            <li className={authedPage === 'growth' ? 'active' : ''} onClick={() => setPage('growth')}>Growth</li>
          )}
          {user?.role === 'admin' && (
            <li className={authedPage === 'data-products' ? 'active' : ''} onClick={() => setPage('data-products')}>Data products</li>
          )}
          {user?.role === 'admin' && (
            <li className={authedPage === 'competition' ? 'active' : ''} onClick={() => setPage('competition')}>Competition evidence</li>
          )}
          <li className={authedPage === 'marketplace' ? 'active' : ''} onClick={() => setPage('marketplace')}>Marketplace</li>
          {user?.role === 'admin' && (
            <li className={authedPage === 'operations' ? 'active' : ''} onClick={() => setPage('operations')}>Operations</li>
          )}
          <li className={authedPage === 'status' ? 'active' : ''} onClick={() => setPage('status')}>Status</li>
          {user?.role === 'admin' && (
            <li className={authedPage === 'trust-portal' ? 'active' : ''} onClick={() => setPage('trust-portal')}>Trust portal</li>
          )}
          {user?.role === 'admin' && (
            <li className={authedPage === 'governance' ? 'active' : ''} onClick={() => setPage('governance')}>Governance</li>
          )}
          <li className={authedPage === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>Settings</li>
          <li className={authedPage === 'pricing' ? 'active' : ''} onClick={() => setPage('pricing')}>Pricing</li>
          <li className={authedPage === 'help' ? 'active' : ''} onClick={() => { window.location.hash = '#help'; setPage('help'); }}>Help centre</li>
        </ul>
        <button className="logout-btn" onClick={logout}>Sign Out</button>
      </nav>
      <main className="content">
        {(authedPage === 'dashboard' || authedPage === 'settings') && (
          <OnboardingWizard onNavigate={setPage} />
        )}
        {authedPage === 'dashboard' && <DashboardPage />}
        {authedPage === 'assistant' && <AssistantPage />}
        {authedPage === 'data' && <EntitiesPage />}
        {authedPage === 'tools' && <ToolsPage />}


        {authedPage === 'trust' && <TrustPage />}
        {authedPage === 'tenants' && user?.role === 'admin' && <TenantsPage />}
        {authedPage === 'ai-economics' && user?.role === 'admin' && <AiEconomicsPage />}
        {authedPage === 'evaluations' && user?.role === 'admin' && <EvaluationsPage />}
        {authedPage === 'growth' && user?.role === 'admin' && <GrowthPage />}
        {authedPage === 'data-products' && user?.role === 'admin' && <DataProductsPage />}
        {authedPage === 'competition' && user?.role === 'admin' && <CompetitionEvidencePage />}
        {authedPage === 'marketplace' && <MarketplacePage user={user} />}
        {authedPage === 'operations' && user?.role === 'admin' && <OperationsPage />}
        {authedPage === 'status' && <StatusPage />}
        {authedPage === 'trust-portal' && user?.role === 'admin' && <TrustPortalPage />}
        {authedPage === 'governance' && user?.role === 'admin' && <GovernancePage />}
        {authedPage === 'settings' && <SettingsPage />}
        {authedPage === 'pricing' && <PricingPage />}
        {authedPage === 'help' && <HelpCenterPage onHome={() => setPage('dashboard')} />}
      </main>
    </div>
  );
}

