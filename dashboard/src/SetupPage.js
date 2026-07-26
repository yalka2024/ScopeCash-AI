import React, { useEffect, useState } from 'react';

/**
 * SetupPage — first-run setup wizard for ScopeCash AI.
 *
 * Routed at #setup; intended for fresh deployments before any admin user
 * exists. On mount we hit GET /api/setup/status:
 *   - If `configured: true`, we redirect to #login.
 *   - Otherwise the operator fills in org name, full name, email and a
 *     strong password, accepts the ToS, and POSTs /api/setup/complete.
 *
 * The endpoint creates the first admin, issues an authenticated session
 * cookie, and we then reload to the dashboard so the operator is straight
 * in.
 */

const API = process.env.REACT_APP_API_URL || '/api';

const PASSWORD_HINT =
  'At least 12 characters with uppercase, lowercase, a digit and a symbol.';

function passwordStrength(pw) {
  const checks = [
    /.{12,}/.test(pw),
    /[a-z]/.test(pw),
    /[A-Z]/.test(pw),
    /\d/.test(pw),
    /[^A-Za-z0-9]/.test(pw),
  ];
  return checks.filter(Boolean).length; // 0..5
}

function StrengthBar({ score }) {
  const pct = Math.min(100, (score / 5) * 100);
  const colour = score >= 5 ? '#16a34a' : score >= 4 ? '#65a30d' : score >= 3 ? '#ca8a04' : score >= 1 ? '#ea580c' : '#dc2626';
  return (
    <div style={{ height: 4, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden', marginTop: 6 }}>
      <div style={{ width: pct + '%', height: '100%', background: colour, transition: 'width .2s' }} />
    </div>
  );
}

async function readCsrfThenFetch(path, body) {
  // Prime CSRF cookie via /api/health (a safe GET) so the protect middleware
  // accepts our POST.
  await fetch(API + '/health', { credentials: 'include' }).catch(() => {});
  const csrf = (document.cookie.match(/(?:^|; )csrf=([^;]+)/) || [])[1] || '';
  return fetch(API + path, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': decodeURIComponent(csrf),
    },
    body: JSON.stringify(body),
  });
}

export default function SetupPage({ onHome, onLogin }) {
  const [statusLoading, setStatusLoading] = useState(true);
  const [configured, setConfigured]       = useState(false);
  const [statusError, setStatusError]     = useState(null);

  const [orgName, setOrgName]             = useState('ScopeCash AI');
  const [adminName, setAdminName]         = useState('');
  const [adminEmail, setAdminEmail]       = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acceptTos, setAcceptTos]         = useState(false);
  const [submitting, setSubmitting]       = useState(false);
  const [error, setError]                 = useState(null);

  useEffect(() => {
    fetch(API + '/setup/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setConfigured(Boolean(d.configured)))
      .catch((e) => setStatusError(e.message || String(e)))
      .finally(() => setStatusLoading(false));
  }, []);

  const score = passwordStrength(adminPassword);
  const passwordsMatch = adminPassword.length > 0 && adminPassword === confirmPassword;
  const formValid =
    orgName.trim().length >= 2 &&
    adminName.trim().length >= 1 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) &&
    score === 5 &&
    passwordsMatch &&
    acceptTos;

  async function submit(e) {
    e.preventDefault();
    if (!formValid || submitting) return;
    setSubmitting(true); setError(null);
    try {
      const r = await readCsrfThenFetch('/setup/complete', {
        orgName: orgName.trim(),
        adminEmail: adminEmail.trim(),
        adminName: adminName.trim(),
        adminPassword,
        acceptTos: true,
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || ('setup_failed_' + r.status));
      // Session cookie is set; jump straight into the dashboard.
      window.location.hash = '#app';
      window.location.reload();
    } catch (e2) {
      setError(e2.message || String(e2));
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#f8fafc',
      fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    }}>
      <div style={{ maxWidth: 540, margin: '0 auto', padding: '40px 20px 60px' }}>
        <header style={{ marginBottom: 24, textAlign: 'center' }}>
          <a href="#home" onClick={(e) => { e.preventDefault(); onHome && onHome(); }}
             style={{ textDecoration: 'none', color: '#475569', fontSize: 13 }}>
            ← ScopeCash AI
          </a>
          <h1 style={{ margin: '8px 0 4px', fontSize: 26, color: '#0f172a' }}>
            Welcome — let&apos;s get you set up
          </h1>
          <p style={{ margin: 0, color: '#64748b', fontSize: 14 }}>
            Create the first administrator account for this ScopeCash AI instance.
          </p>
        </header>

        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 28 }}>
          {statusLoading && <p style={{ color: '#64748b', fontSize: 14, margin: 0 }}>Checking setup status…</p>}

          {!statusLoading && statusError && (
            <div role="alert" style={{
              background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca',
              padding: '10px 14px', borderRadius: 8, fontSize: 13,
            }}>
              Couldn&apos;t reach the setup endpoint: {statusError}
            </div>
          )}

          {!statusLoading && configured && (
            <div>
              <div role="status" style={{
                background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0',
                padding: '12px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600, marginBottom: 14,
              }}>
                ✓ This ScopeCash AI instance is already configured.
              </div>
              <p style={{ color: '#475569', fontSize: 14, margin: '0 0 16px' }}>
                Sign in with your existing administrator account to continue.
              </p>
              <button
                type="button"
                onClick={() => { onLogin ? onLogin() : (window.location.hash = '#login'); }}
                style={{
                  background: '#0f172a', color: '#fff', border: 0,
                  padding: '10px 22px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                }}
              >Go to sign in →</button>
            </div>
          )}

          {!statusLoading && !configured && !statusError && (
            <form onSubmit={submit} aria-label="First-run setup form">
              {error && (
                <div role="alert" aria-live="assertive" style={{
                  background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca',
                  padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 14,
                }}>{error}</div>
              )}

              <Field label="Organisation name" hint="Shown in the header and on legal documents.">
                <input
                  type="text" required value={orgName} onChange={(e) => setOrgName(e.target.value)}
                  style={inputStyle} maxLength={120} />
              </Field>

              <Field label="Your full name">
                <input
                  type="text" required value={adminName} onChange={(e) => setAdminName(e.target.value)}
                  placeholder="Jane Doe" style={inputStyle} maxLength={120} />
              </Field>

              <Field label="Administrator email" hint="Used for sign-in and platform notifications.">
                <input
                  type="email" required value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="you@company.com" style={inputStyle} maxLength={254} />
              </Field>

              <Field label="Password" hint={PASSWORD_HINT}>
                <input
                  type="password" required value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)}
                  autoComplete="new-password" style={inputStyle} maxLength={256} />
                <StrengthBar score={score} />
              </Field>

              <Field label="Confirm password">
                <input
                  type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password" style={inputStyle} maxLength={256} />
                {confirmPassword.length > 0 && !passwordsMatch && (
                  <p style={{ color: '#dc2626', fontSize: 12, margin: '4px 0 0' }}>Passwords don&apos;t match.</p>
                )}
              </Field>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: '#475569', margin: '14px 0 18px' }}>
                <input type="checkbox" checked={acceptTos} onChange={(e) => setAcceptTos(e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  I accept the{' '}
                  <a href="#terms" style={{ color: '#0f172a' }}>Terms of Service</a>{' '}
                  and acknowledge the{' '}
                  <a href="#privacy" style={{ color: '#0f172a' }}>Privacy Notice</a>.
                </span>
              </label>

              <button type="submit" disabled={!formValid || submitting} style={{
                width: '100%', background: '#0f172a', color: '#fff', border: 0,
                padding: '12px 22px', borderRadius: 8, fontSize: 15, fontWeight: 600,
                cursor: (!formValid || submitting) ? 'not-allowed' : 'pointer',
                opacity: (!formValid || submitting) ? 0.5 : 1,
              }}>{submitting ? 'Creating administrator…' : 'Complete setup →'}</button>
            </form>
          )}
        </div>

        <p style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', margin: '20px 0 0' }}>
          ScopeCash AI · Setup runs only once per deployment.
        </p>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: 11, fontSize: 14, color: '#0f172a',
  border: '1px solid #e2e8f0', borderRadius: 8, fontFamily: 'inherit',
  boxSizing: 'border-box', background: '#fff',
};

function Field({ label, hint, children }) {
  const id   = 'fld-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const hintId = hint ? id + '-hint' : undefined;
  // Inject id + aria-describedby into the wrapped input element.
  const child = React.Children.map(children, (c) =>
    React.isValidElement(c) && c.type === 'input'
      ? React.cloneElement(c, { id, 'aria-label': label, 'aria-describedby': hintId })
      : c
  );
  return (
    <div style={{ marginBottom: 14 }}>
      <label htmlFor={id} style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>
        {label}
      </label>
      {child}
      {hint && <p id={hintId} style={{ fontSize: 12, color: '#64748b', margin: '4px 0 0' }}>{hint}</p>}
    </div>
  );
}

