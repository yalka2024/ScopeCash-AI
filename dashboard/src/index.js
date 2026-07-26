import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './a11y.css';
import { I18nProvider } from './i18n';
import { initSentry } from './sentry';
import CookieBanner from './CookieBanner';
import SafetyBanner from './SafetyBanner';

initSentry();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <I18nProvider>
      <SafetyBanner />
      <a href="#main" className="skip-link">Skip to main content</a>
      <App />
      <CookieBanner />
    </I18nProvider>
  </React.StrictMode>
);

