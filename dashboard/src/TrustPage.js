import React, { useEffect, useState } from 'react';

const API = process.env.REACT_APP_API_URL || '/api';

export default function TrustPage() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API}/trust/summary`, { credentials: 'omit' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Failed to load /trust/summary')))
      .then(setSummary)
      .catch(e => setError(e.message));
  }, []);

  if (error) return <div style={{ padding: '2rem' }}><h2>Trust</h2><p style={{ color: '#ff6b6b' }}>{error}</p></div>;
  if (!summary) return <div style={{ padding: '2rem' }}><h2>Trust</h2><p style={{ color: '#888' }}>Loading…</p></div>;

  return (
    <div style={{ padding: '2rem' }}>
      <h2>Trust & Compliance</h2>
      <p style={{ color: '#888' }}>
        Live security & compliance posture for {summary.platform}. Generated{' '}
        {new Date(summary.generatedAt).toLocaleString()}.
      </p>

      <div style={grid}>
        <Card title="Compliance frameworks">
          {summary.compliance.frameworks.length === 0
            ? <p style={{ color: '#888' }}>No frameworks declared.</p>
            : <ul style={list}>{summary.compliance.frameworks.map(f => <li key={f}>{f}</li>)}</ul>}
          <p style={muted}>Attested: {summary.compliance.attested ? 'Yes' : 'No (self-assessed)'}</p>
        </Card>

        <Card title="Security controls">
          <p><strong>{summary.security.controls_count}</strong> mapped controls</p>
          <ul style={list}>
            <li>Encryption in transit: {summary.security.encryption_in_transit}</li>
            <li>Encryption at rest: {summary.security.encryption_at_rest}</li>
            <li>MFA: {summary.security.mfa_supported ? '✓' : '✗'}</li>
            <li>SSO: {summary.security.sso_supported ? '✓' : '✗'}</li>
            <li>Audit log: {summary.security.audit_log ? '✓' : '✗'}</li>
            <li>Data residency: {(summary.security.data_residency || []).join(', ')}</li>
          </ul>
          <p style={muted}>SBOM: {summary.security.sbom}</p>
        </Card>

        <Card title="Sub-processors">
          <p><strong>{summary.subprocessors.count}</strong> active</p>
          <ul style={list}>
            {(summary.subprocessors.list || []).map(s => (
              <li key={s.name}>
                <strong>{s.name}</strong> — {s.purpose} <span style={muted}>({s.location})</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Documents">
          <ul style={list}>
            {(summary.documents || []).map(d => (
              <li key={d.name}>
                <a href={`${API}/trust/documents/${d.name}`} target="_blank" rel="noreferrer">{d.name}</a>
                {' '}<span style={muted}>({(d.size_bytes / 1024).toFixed(1)} KB · sha256:{d.sha256.slice(0, 12)}…)</span>
              </li>
            ))}
          </ul>
          <a href={`${API}/trust/pack`} style={btnPrimary}>Download compliance pack (ZIP)</a>
        </Card>

        <Card title="Incident response">
          <p>Notification SLA: <strong>{summary.incident_response.notification_sla_hours}h</strong></p>
          <p>Contact: <a href={`mailto:${summary.incident_response.contact}`}>{summary.incident_response.contact}</a></p>
        </Card>

        <Card title="Data handling">
          <p>Deletion SLA: <strong>{summary.data_handling.deletion_sla_days} days</strong></p>
          <p>Export formats: {(summary.data_handling.export_formats || []).join(', ')}</p>
          <p style={muted}>DSR endpoint: <code>{summary.data_handling.gdpr_dsr_endpoint}</code></p>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {children}
    </div>
  );
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem', marginTop: '1.5rem' };
const card = { background: 'hsl(222 47% 13%)', border: '1px solid hsl(217 33% 24%)', padding: '1.25rem 1.5rem', borderRadius: '8px' };
const list = { paddingLeft: '1.2rem', margin: '0.5rem 0' };
const muted = { color: 'hsl(215 20% 65%)', fontSize: '0.9rem', margin: '0.25rem 0' };
const btnPrimary = {
  display: 'inline-block', marginTop: '1rem',
  padding: '0.5rem 1rem', background: 'hsl(263 70% 60%)', color: '#fff',
  borderRadius: '6px', textDecoration: 'none', fontWeight: 600,
};

