import React, { useEffect, useState } from 'react';

/**
 * GDPR / ePrivacy cookie consent banner.
 *
 * Behaviour:
 *   - Shows on first visit (no `cookie_consent` in localStorage).
 *   - Three buttons: Accept all, Reject non-essential, Customise.
 *   - Customise opens a modal with two togglable categories
 *     (Analytics, Marketing). Strictly-necessary always-on.
 *   - Stores `{ version, decision, categories, ts }` in localStorage and
 *     emits a `window` event 'cookie-consent-changed' that other scripts
 *     can listen for to load/unload trackers.
 *   - Re-prompts only if the consent record is older than 12 months OR the
 *     consent VERSION below changes (re-consent on policy update).
 *   - Footer "Cookie settings" link reopens the modal — implement by
 *     setting localStorage.removeItem('cookie_consent') and reloading,
 *     OR call window.openCookieSettings() exposed below.
 */

const VERSION = 1;
const STORE_KEY = 'cookie_consent';
const MAX_AGE_DAYS = 365;

function readConsent() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || v.version !== VERSION) return null;
    if (typeof v.ts !== 'number') return null;
    if (Date.now() - v.ts > MAX_AGE_DAYS * 86400 * 1000) return null;
    return v;
  } catch { return null; }
}

function writeConsent(decision, categories) {
  const record = { version: VERSION, decision, categories, ts: Date.now() };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(record)); } catch {}
  try { window.dispatchEvent(new CustomEvent('cookie-consent-changed', { detail: record })); } catch {}
  return record;
}

const ALL_OFF = { analytics: false, marketing: false };
const ALL_ON  = { analytics: true,  marketing: true  };

const styles = {
  banner: {
    position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
    background: '#0d1b2a', color: '#fff',
    padding: '1rem 1.25rem',
    borderTop: '1px solid #2c64f4',
    boxShadow: '0 -4px 16px rgba(0,0,0,0.15)',
    fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    fontSize: '0.9rem',
    lineHeight: 1.5,
  },
  inner: {
    maxWidth: 1120, margin: '0 auto',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    flexWrap: 'wrap', gap: '1rem',
  },
  text: { flex: '1 1 320px', minWidth: 280 },
  btnRow: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  btn: {
    padding: '0.55rem 1rem', borderRadius: 6, border: '1px solid rgba(255,255,255,0.25)',
    background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: '0.88rem', fontWeight: 600,
  },
  btnPrimary: {
    padding: '0.55rem 1rem', borderRadius: 6, border: 'none',
    background: '#2c64f4', color: '#fff', cursor: 'pointer', fontSize: '0.88rem', fontWeight: 600,
  },
  modalBackdrop: {
    position: 'fixed', inset: 0, background: 'rgba(13,27,42,0.6)', zIndex: 10000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
  },
  modal: {
    background: '#fff', color: '#0d1b2a', borderRadius: 10, maxWidth: 540, width: '100%',
    padding: '1.5rem', fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    maxHeight: '85vh', overflowY: 'auto',
  },
  category: {
    border: '1px solid #e3e8f0', borderRadius: 8, padding: '0.85rem 1rem',
    margin: '0.5rem 0', display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
  },
};

function ConsentModal({ initial, onSave, onClose }) {
  const [cats, setCats] = useState(initial || ALL_OFF);
  return (
    <div style={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Cookie preferences">
      <div style={styles.modal}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>Cookie preferences</h2>
        <p style={{ margin: '0 0 1rem', color: '#5a6b85', fontSize: '0.92rem' }}>
          We use strictly necessary cookies to operate the service. Other categories are
          off by default and require your explicit consent. You can change this any time
          via the "Cookie settings" link in the footer.
        </p>

        <div style={{ ...styles.category, background: '#f6f8fc' }}>
          <input type="checkbox" checked readOnly aria-label="Strictly necessary (always on)" style={{ marginTop: 4 }} />
          <div>
            <strong style={{ display: 'block' }}>Strictly necessary</strong>
            <span style={{ fontSize: '0.85rem', color: '#5a6b85' }}>
              Session, CSRF protection, load balancing. Required for the service to work — cannot be disabled.
            </span>
          </div>
        </div>

        <label style={styles.category}>
          <input
            type="checkbox"
            checked={cats.analytics}
            onChange={(e) => setCats({ ...cats, analytics: e.target.checked })}
            style={{ marginTop: 4 }}
          />
          <div>
            <strong style={{ display: 'block' }}>Analytics</strong>
            <span style={{ fontSize: '0.85rem', color: '#5a6b85' }}>
              Aggregated usage statistics that help us improve the product. No cross-site tracking.
            </span>
          </div>
        </label>

        <label style={styles.category}>
          <input
            type="checkbox"
            checked={cats.marketing}
            onChange={(e) => setCats({ ...cats, marketing: e.target.checked })}
            style={{ marginTop: 4 }}
          />
          <div>
            <strong style={{ display: 'block' }}>Marketing</strong>
            <span style={{ fontSize: '0.85rem', color: '#5a6b85' }}>
              Re-engagement and attribution. Off by default.
            </span>
          </div>
        </label>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1.25rem', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" onClick={onClose} style={{ ...styles.btn, color: '#0d1b2a', borderColor: '#e3e8f0' }}>Cancel</button>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => onSave('rejected', ALL_OFF)} style={{ ...styles.btn, color: '#0d1b2a', borderColor: '#e3e8f0' }}>Reject non-essential</button>
            <button type="button" onClick={() => onSave('custom',   cats)}    style={styles.btnPrimary}>Save preferences</button>
          </div>
        </div>

        <p style={{ marginTop: '1rem', fontSize: '0.78rem', color: '#5a6b85' }}>
          See our <a href="#privacy" style={{ color: '#2c64f4' }}>Privacy notice</a> for full detail on data processing.
        </p>
      </div>
    </div>
  );
}

export default function CookieBanner() {
  const [consent, setConsent] = useState(() => readConsent());
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    // Expose a global so the footer link can reopen settings.
    window.openCookieSettings = () => setShowModal(true);
    return () => { try { delete window.openCookieSettings; } catch {} };
  }, []);

  function handle(decision, cats) {
    const rec = writeConsent(decision, cats);
    setConsent(rec);
    setShowModal(false);
  }

  // Banner hidden once a valid consent record exists, unless modal is open.
  const showBanner = !consent && !showModal;

  return (
    <>
      {showBanner && (
        <div role="region" aria-label="Cookie consent" style={styles.banner}>
          <div style={styles.inner}>
            <div style={styles.text}>
              We use strictly necessary cookies to run the service. With your consent, we'd
              also like to use analytics and marketing cookies. See our{' '}
              <a href="#privacy" style={{ color: '#9ec1ff' }}>privacy notice</a>.
            </div>
            <div style={styles.btnRow}>
              <button type="button" onClick={() => handle('rejected', ALL_OFF)} style={styles.btn}>Reject</button>
              <button type="button" onClick={() => setShowModal(true)}          style={styles.btn}>Customise</button>
              <button type="button" onClick={() => handle('accepted', ALL_ON)}  style={styles.btnPrimary}>Accept all</button>
            </div>
          </div>
        </div>
      )}
      {showModal && (
        <ConsentModal
          initial={consent ? consent.categories : ALL_OFF}
          onSave={handle}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

/** Helper for other modules: returns true if a category is consented to. */
export function hasConsent(category) {
  const c = readConsent();
  if (!c) return false;
  if (category === 'necessary') return true;
  return Boolean(c.categories && c.categories[category]);
}

