// Default to a RELATIVE `/api` so the app works same-origin (preview /
// SERVE_DASHBOARD / nginx) out of the box. In split dev (Vite on :3000) the
// vite.config proxy forwards /api → the API on :4000. Override at build time
// with REACT_APP_API_URL for a cross-origin API.
const API_URL = process.env.REACT_APP_API_URL || '/api';

// Listeners are notified when auth becomes invalid (e.g. on 401).
const authListeners = new Set();
export function onAuthChange(fn) { authListeners.add(fn); return () => authListeners.delete(fn); }
function notifyAuthCleared() {
  try { localStorage.removeItem('user'); } catch {}
  for (const fn of authListeners) { try { fn(); } catch {} }
}

// CSRF helper: read cookie set by server (`csrf=<token>`)
function readCookie(name) {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function isUnsafe(method) {
  const m = (method || 'GET').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

let refreshInFlight = null;
async function tryRefresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const csrf = readCookie('csrf');
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST', credentials: 'include',
        headers: csrf ? { 'x-csrf-token': csrf } : {}
      });
      return res.ok;
    } catch { return false; }
    finally { setTimeout(() => { refreshInFlight = null; }, 0); }
  })();
  return refreshInFlight;
}

async function apiFetch(path, options = {}, _retry = false) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (isUnsafe(options.method)) {
    const csrf = readCookie('csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(`${API_URL}${path}`, { ...options, headers, credentials: 'include' });
  if (res.status === 401 && !_retry) {
    const ok = await tryRefresh();
    if (ok) return apiFetch(path, options, true);
    notifyAuthCleared();
    throw new Error('Unauthorized');
  }
  return res;
}

async function apiFetchForm(path, formData, _retry = false) {
  const headers = {};
  const csrf = readCookie('csrf');
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST', credentials: 'include', headers, body: formData
  });
  if (res.status === 401 && !_retry) {
    const ok = await tryRefresh();
    if (ok) return apiFetchForm(path, formData, true);
    notifyAuthCleared();
    throw new Error('Unauthorized');
  }
  return res;
}

export async function login(email, password, mfaToken) {
  const res = await apiFetch('/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password, mfaToken })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
  return data;
}

export async function register(email, password, name) {
  const res = await apiFetch('/auth/register', {
    method: 'POST', body: JSON.stringify({ email, password, name })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Registration failed');
  if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
  return data;
}

export async function logout() {
  try { await apiFetch('/auth/logout', { method: 'POST' }); } catch {}
  notifyAuthCleared();
}

export async function me() {
  const res = await apiFetch('/auth/me');
  if (!res.ok) return null;
  const data = await res.json();
  if (data && data.user) localStorage.setItem('user', JSON.stringify(data.user));
  return data;
}

export function getUser() {
  try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
}
export function isLoggedIn() { return !!getUser(); }

// Billing (Tier 10)
export async function getBillingUsage() {
  const res = await apiFetch('/billing/usage');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load billing');
  return data;
}
export async function getPublicPlans() {
  // Unauthenticated — used by the public pricing page.
  const res = await fetch(`${API_URL}/billing/plans/public`, { credentials: 'omit' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load plans');
  return data;
}
export async function startCheckout(tierId, cadence = 'monthly') {
  const res = await apiFetch('/billing/checkout', {
    method: 'POST', body: JSON.stringify({ tierId, cadence }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Checkout failed');
  return data;
}
export async function openBillingPortal() {
  const res = await apiFetch('/billing/portal', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Portal unavailable');
  return data;
}

// MFA
export async function mfaSetup() {
  const res = await apiFetch('/auth/mfa/setup', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'MFA setup failed');
  return data; // { secret, otpauth }
}
export async function mfaEnable(token) {
  const res = await apiFetch('/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ token }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'MFA enable failed');
  return data;
}
export async function mfaDisable(token) {
  const res = await apiFetch('/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ token }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'MFA disable failed');
  return data;
}

export async function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetchForm(`/projects`, form);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

export async function uploadFiles(files) {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await apiFetchForm(`/projects/batch`, form);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

export async function getRecords(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await apiFetch(`/projects?${qs}`);
  return res.json();
}

export async function getRecord(id) {
  const res = await apiFetch(`/projects/${id}`);
  return res.json();
}

export async function getDownloadUrl(id) {
  const res = await apiFetch(`/projects/${id}/download-url`);
  return res.json();
}

export async function deleteRecord(id) {
  const res = await apiFetch(`/projects/${id}`, { method: 'DELETE' });
  return res.json();
}

export async function getAnalytics() {
  const res = await apiFetch('/analytics/overview');
  return res.json();
}

// ─── Onboarding wizard ────────────────────────────────────────
export async function getOnboarding() {
  const res = await apiFetch('/growth/onboarding');
  if (!res.ok) throw new Error('Failed to load onboarding state');
  return res.json();
}
export async function markOnboardingStep(step, properties) {
  const res = await apiFetch(`/growth/onboarding/${encodeURIComponent(step)}`, {
    method: 'POST',
    body: JSON.stringify({ properties: properties || {} }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to mark step');
  }
  return res.json();
}
export async function trackGrowthEvent(name, properties) {
  try {
    await apiFetch('/growth/events', {
      method: 'POST',
      body: JSON.stringify({ name, properties: properties || {} }),
    });
  } catch {} // best-effort
}

export async function getNotifications() {
  const res = await apiFetch('/notifications');
  return res.json();
}

export async function checkBetaStatus() {
  try {
    const res = await fetch(`${API_URL}/health`);
    const data = await res.json();
    return data.beta === true;
  } catch { return false; }
}

/**
 * Generic JSON helper used by admin pages (Tenants, AI economics).
 * - Accepts paths with or without the `/api` prefix.
 * - Automatically parses JSON and throws on non-2xx responses.
 */
export async function apiJson(path, options = {}) {
  const stripped = path.startsWith('/api/') ? path.slice(4) : path;
  const res = await apiFetch(stripped, options);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ─── Agents (list + token streaming) ─────────────────────────────
export async function listAgents() {
  const res = await apiFetch('/agents');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { agents: [{ name, description, ... }] }
}

/**
 * Streams an agent run over SSE (fetch + ReadableStream — works for POST, unlike
 * EventSource). Calls onEvent(evt) for each event the server emits:
 *   { type:'step', step, agent } | { type:'text', text } | { type:'tool', name }
 *   { type:'escalate', from, to } | { type:'final', output } | { type:'error', error } | { type:'done' }
 * Resolves when the stream ends. Pass an AbortSignal to cancel mid-stream.
 */
export async function streamAgentRun(name, input, { onEvent, model, session, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const csrf = readCookie('csrf');
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`${API_URL}/agents/${encodeURIComponent(name)}/run/stream`, {
    method: 'POST', credentials: 'include', headers, signal,
    body: JSON.stringify({ input, ...(model ? { model } : {}), ...(session ? { session } : {}) }),
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload) continue;
        try { onEvent && onEvent(JSON.parse(payload)); } catch { /* ignore keep-alive/partial */ }
      }
    }
  }
}


