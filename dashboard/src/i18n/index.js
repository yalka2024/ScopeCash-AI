// Lightweight i18n — no extra dependency.
// Usage:
//   import { I18nProvider, useT, useLocale } from './i18n';
//   const t = useT();  t('auth.signIn');
//
// Locale resolution (in order):
//   1. localStorage 'locale'
//   2. navigator.language prefix (e.g. 'fr-FR' → 'fr')
//   3. fallback 'en'

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './en.json';
import es from './es.json';
import fr from './fr.json';

const BUNDLES = { en, es, fr };
const FALLBACK = 'en';

function detectLocale() {
  try {
    const stored = window.localStorage.getItem('locale');
    if (stored && BUNDLES[stored]) return stored;
  } catch {}
  const nav = (navigator.language || FALLBACK).slice(0, 2).toLowerCase();
  return BUNDLES[nav] ? nav : FALLBACK;
}

function lookup(bundle, key) {
  return key.split('.').reduce((acc, part) => (acc && acc[part] != null ? acc[part] : undefined), bundle);
}

function format(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

const I18nCtx = createContext({
  locale: FALLBACK,
  setLocale: () => {},
  t: (k) => k,
});

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(detectLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    try { window.localStorage.setItem('locale', locale); } catch {}
  }, [locale]);

  const t = useCallback((key, vars) => {
    const value = lookup(BUNDLES[locale], key) ?? lookup(BUNDLES[FALLBACK], key) ?? key;
    return typeof value === 'string' ? format(value, vars) : key;
  }, [locale]);

  const value = useMemo(() => ({
    locale,
    setLocale: (l) => { if (BUNDLES[l]) setLocaleState(l); },
    availableLocales: Object.keys(BUNDLES),
    t,
  }), [locale, t]);

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useT()      { return useContext(I18nCtx).t; }
export function useLocale() { return useContext(I18nCtx); }

