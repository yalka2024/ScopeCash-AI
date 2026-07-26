import React, { useEffect, useState } from 'react';
import {
  getConformity, startConformity, updateConformityItem, attestConformity,
} from './api';

const STATUS_COLORS = {
  not_started:    { bg: 'hsl(217 33% 17%)',      fg: '#9ca3af', label: 'Not started' },
  in_progress:    { bg: 'rgba(251,191,36,0.15)', fg: '#fbbf24', label: 'In progress' },
  satisfied:      { bg: 'rgba(52,211,153,0.15)', fg: '#34d399', label: 'Satisfied' },
  not_applicable: { bg: 'rgba(165,180,252,0.15)', fg: '#a5b4fc', label: 'N/A' },
  failed:         { bg: 'rgba(248,113,113,0.15)', fg: '#f87171', label: 'Failed' },
};

const ROUTE_LABEL = {
  internal_control_annex_vi: 'Internal control (Annex VI)',
  notified_body_annex_vii:   'Notified body (Annex VII)',
};

export default function ConformityCard({ recordId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openSection, setOpenSection] = useState(null);
  const [signName, setSignName] = useState('');
  const [signRole, setSignRole] = useState('');

  const load = async () => {
    setLoading(true); setError(null);
    try { setData(await getConformity(recordId)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [recordId]);

  if (loading) return <div style={S.card}><em>Loading conformity status…</em></div>;
  if (error)   return <div style={S.card}><strong style={{ color: '#fca5a5' }}>{error}</strong></div>;
  if (!data)   return null;

  const state   = data.state;
  const summary = data.summary;
  const fresh   = state.status === 'draft' && summary.completionPercentage === 0 && !state.signedAt && state.startedAt && (Date.now() - new Date(state.startedAt).getTime() < 5000);

  const start = async (route) => {
    setBusy(true);
    try { setData(await startConformity(recordId, route)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const setItemStatus = async (itemId, status) => {
    setBusy(true);
    try { setData(await updateConformityItem(recordId, itemId, { status })); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const setEvidence = async (itemId, evidence) => {
    setBusy(true);
    try { setData(await updateConformityItem(recordId, itemId, { evidence })); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const attest = async () => {
    if (!signName || !signRole) { setError('Provide signatory name and role.'); return; }
    setBusy(true); setError(null);
    try { setData(await attestConformity(recordId, signName, signRole)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const isAttested = state.status === 'attested';

  return (
    <div style={S.card}>
      <div style={S.header}>
        <div>
          <div style={S.title}>Conformity Assessment <span style={S.badge}>Article 43</span></div>
          <div style={S.muted}>Route: {ROUTE_LABEL[state.route] || state.route}</div>
        </div>
        <div style={S.right}>
          <div style={S.bigPct}>{summary.completionPercentage}%</div>
          <div style={S.muted}>{summary.satisfied} ✓ · {summary.notApplicable} N/A · {summary.failed} ✗ · {summary.total} total</div>
        </div>
      </div>

      {fresh && !isAttested && (
        <div style={S.notice}>Assessment started. Work through each section below; mark every item as satisfied, N/A, or failed before attesting.</div>
      )}

      {/* Show start button only if assessment hasn't been started AND backend returned default template */}
      {!state.startedAt && !isAttested && (
        <div style={S.startRow}>
          <button onClick={() => start('internal_control_annex_vi')} disabled={busy} style={S.btnPrimary}>
            Start internal control (Annex VI)
          </button>
          <button onClick={() => start('notified_body_annex_vii')} disabled={busy} style={S.btnSecondary}>
            Start with notified body (Annex VII)
          </button>
        </div>
      )}

      {/* Progress bar */}
      <div style={S.progressTrack}>
        <div style={{ ...S.progressFill, width: `${summary.completionPercentage}%`, background: isAttested ? '#10b981' : '#3b82f6' }} />
      </div>

      {/* Sections */}
      <div style={{ marginTop: 16 }}>
        {state.sections.map(sec => {
          const secStats = sec.items.reduce((acc, it) => {
            acc.total++;
            if (it.status === 'satisfied' || it.status === 'not_applicable') acc.done++;
            else if (it.status === 'failed') acc.failed++;
            return acc;
          }, { total: 0, done: 0, failed: 0 });
          const open = openSection === sec.article;
          return (
            <div key={sec.article} style={S.section}>
              <button onClick={() => setOpenSection(open ? null : sec.article)} style={S.sectionHeader}>
                <span style={S.sectionTitle}>
                  <span style={S.articleChip}>Art. {sec.article}</span>
                  {sec.section}
                </span>
                <span style={S.muted}>
                  {secStats.done}/{secStats.total} done{secStats.failed ? ` · ${secStats.failed} failed` : ''}
                </span>
              </button>
              {open && (
                <div style={S.itemsList}>
                  {sec.items.map(it => (
                    <ItemRow key={it.id} item={it} disabled={busy || isAttested}
                      onStatus={(s) => setItemStatus(it.id, s)}
                      onEvidence={(ev) => setEvidence(it.id, ev)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Attestation */}
      {!isAttested && summary.readyForAttestation && (
        <div style={S.attestBox}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Ready to attest</div>
          <div style={S.muted}>
            By signing, you declare under your sole responsibility that the system conforms to the requirements
            of Articles 8–15 of the EU AI Act (Article 47 declaration of conformity).
          </div>
          <div style={S.signRow}>
            <input value={signName} onChange={(e) => setSignName(e.target.value)} placeholder="Signatory name" style={S.input} />
            <input value={signRole} onChange={(e) => setSignRole(e.target.value)} placeholder="Role/title" style={S.input} />
            <button onClick={attest} disabled={busy} style={S.btnPrimary}>Sign & attest</button>
          </div>
        </div>
      )}

      {isAttested && (
        <div style={S.attestedBox}>
          <div style={{ fontWeight: 600 }}>✓ Attested</div>
          <div style={S.muted}>
            Signed by <strong>{state.signatureName}</strong> ({state.signatureRole}) on {new Date(state.signedAt).toLocaleString()}.
            This declaration must be kept on file for 10 years per Article 47.
          </div>
        </div>
      )}

      {error && <div style={S.errorBox}>{error}</div>}
    </div>
  );
}

function ItemRow({ item, disabled, onStatus, onEvidence }) {
  const [evidence, setLocalEv] = useState(item.evidence || '');
  const [showEv, setShowEv] = useState(!!item.evidence);
  const colors = STATUS_COLORS[item.status] || STATUS_COLORS.not_started;
  return (
    <div style={S.item}>
      <div style={S.itemQ}>{item.question}</div>
      <div style={S.itemControls}>
        <select value={item.status} disabled={disabled}
          onChange={(e) => onStatus(e.target.value)}
          style={{ ...S.statusSelect, background: colors.bg, color: colors.fg, borderColor: colors.fg }}>
          {Object.entries(STATUS_COLORS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <button onClick={() => setShowEv(!showEv)} style={S.evToggle}>
          {item.evidence ? '✎ Evidence' : '+ Add evidence'}
        </button>
      </div>
      {showEv && (
        <div style={{ marginTop: 8 }}>
          <textarea
            value={evidence}
            disabled={disabled}
            onChange={(e) => setLocalEv(e.target.value)}
            onBlur={() => evidence !== item.evidence && onEvidence(evidence)}
            placeholder="Document or link supporting evidence (max 4000 chars)"
            style={S.evTextarea}
            maxLength={4000}
          />
        </div>
      )}
    </div>
  );
}

const S = {
  card: { background: 'hsl(222 47% 13%)', border: '1px solid hsl(217 33% 24%)', borderRadius: 12, padding: 20, marginTop: 16 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 },
  title: { fontSize: 18, fontWeight: 700, color: 'hsl(210 40% 98%)' },
  badge: { fontSize: 11, padding: '2px 8px', background: 'rgba(165,180,252,0.15)', color: '#a5b4fc', borderRadius: 999, marginLeft: 8, fontWeight: 600 },
  muted: { color: 'hsl(215 20% 65%)', fontSize: 13 },
  right: { textAlign: 'right' },
  bigPct: { fontSize: 28, fontWeight: 700, color: 'hsl(210 40% 98%)' },
  notice: { background: 'rgba(59,130,246,0.12)', color: '#93c5fd', padding: 10, borderRadius: 6, marginTop: 12, fontSize: 13 },
  startRow: { display: 'flex', gap: 8, marginTop: 12 },
  btnPrimary: { background: 'hsl(263 70% 60%)', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, fontWeight: 600, cursor: 'pointer' },
  btnSecondary: { background: 'transparent', color: 'hsl(263 70% 75%)', border: '1px solid hsl(263 70% 60%)', padding: '8px 14px', borderRadius: 6, fontWeight: 600, cursor: 'pointer' },
  progressTrack: { background: 'hsl(217 33% 20%)', height: 8, borderRadius: 4, marginTop: 16, overflow: 'hidden' },
  progressFill: { height: '100%', transition: 'width 0.3s' },
  section: { border: '1px solid hsl(217 33% 24%)', borderRadius: 8, marginBottom: 8, overflow: 'hidden' },
  sectionHeader: { width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'hsl(222 47% 11%)', border: 'none', cursor: 'pointer', textAlign: 'left' },
  sectionTitle: { fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'hsl(210 40% 96%)' },
  articleChip: { fontSize: 11, padding: '2px 6px', background: 'hsl(263 70% 60%)', color: '#fff', borderRadius: 4, fontWeight: 600 },
  itemsList: { padding: 12, background: 'hsl(222 47% 13%)' },
  item: { padding: '10px 0', borderBottom: '1px solid hsl(217 33% 20%)' },
  itemQ: { fontSize: 13, color: 'hsl(210 40% 96%)', marginBottom: 6 },
  itemControls: { display: 'flex', gap: 8, alignItems: 'center' },
  statusSelect: { padding: '4px 8px', borderRadius: 4, border: '1px solid', fontSize: 12, fontWeight: 600 },
  evToggle: { background: 'none', border: '1px dashed hsl(217 33% 40%)', color: 'hsl(215 20% 65%)', padding: '4px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12 },
  evTextarea: { width: '100%', minHeight: 60, padding: 8, border: '1px solid hsl(217 33% 24%)', borderRadius: 4, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box', background: 'hsl(222 47% 9%)', color: 'hsl(210 40% 96%)' },
  attestBox: { marginTop: 16, padding: 14, background: 'rgba(251,191,36,0.12)', border: '1px solid #f59e0b', borderRadius: 8, color: 'hsl(210 40% 96%)' },
  attestedBox: { marginTop: 16, padding: 14, background: 'rgba(52,211,153,0.12)', border: '1px solid #10b981', borderRadius: 8, color: 'hsl(210 40% 96%)' },
  signRow: { display: 'flex', gap: 8, marginTop: 10 },
  input: { flex: 1, padding: '8px 10px', border: '1px solid hsl(217 33% 24%)', borderRadius: 6, fontSize: 13, background: 'hsl(222 47% 9%)', color: 'hsl(210 40% 96%)' },
  errorBox: { marginTop: 12, padding: 10, background: 'rgba(248,113,113,0.12)', color: '#fca5a5', borderRadius: 6, fontSize: 13 },
};

