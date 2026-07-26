import React from 'react';
import { SAFETY } from './safety';

/**
 * Non-dismissable safety watermark. Renders only when this platform targets a
 * safety-critical / regulated domain (see safety.js), so anyone USING the running
 * dashboard sees the notice — not just people who read the README.
 *
 * Two severities:
 *   - clinical-ops (amber, informational): a packable booking/ops layer that
 *     routes real clinical questions to a licensed human — accurate to disclose,
 *     not a "do not use" alarm.
 *   - everything else gated (red, hard warning): unvalidated regulated scaffolding
 *     that must not be mistaken for a production, licensed-data-backed product.
 */
const isClinicalOps = SAFETY && SAFETY.tier === 'clinical-ops';

const baseStyle = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 99999,
  color: '#fff',
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.35,
  textAlign: 'center',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
};
const bannerStyle = isClinicalOps
  ? { ...baseStyle, background: '#b45309' } // amber-700 — informational
  : { ...baseStyle, background: '#b91c1c' }; // red-700 — hard warning

export default function SafetyBanner() {
  if (!SAFETY || !SAFETY.gated) return null;
  const category = SAFETY.category ? ` (${SAFETY.category})` : '';
  if (isClinicalOps) {
    return (
      <div role="note" style={bannerStyle}>
        {'ℹ️'} Automated booking assistant — not a medical provider. It schedules
        appointments and routes any clinical question to licensed staff; it does not
        diagnose, advise, or treat. Not for clinical or diagnostic use.
      </div>
    );
  }
  return (
    <div role="alert" style={bannerStyle}>
      {'⛔'} SCAFFOLD ONLY — NOT FOR PRODUCTION OR CLINICAL / REGULATED USE{category}.
      {' '}Domain &amp; compliance logic is unvalidated scaffolding — do not rely on it for real decisions.
    </div>
  );
}

