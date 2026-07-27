import React, { useEffect, useRef, useState } from 'react';
import { apiJson, xhrRequest, apiFetchXhr } from './api';
import { Button } from './components/ui/button';

// Kept in sync by hand with the identical allow-lists in
// server/routes/evidence.js (DOCUMENT_EXTS/IMAGE_EXTS/AUDIO_EXTS) — the
// server's own copy is the one actually enforced (via
// storage.js#sniffMagicBytes) and is the source of truth; there's no
// shared module between dashboard/ and server/ to import from today.
// Client and server drifting out of sync would show up as a client-
// accepted file the server then rejects (or vice versa), not silently.
const DOCUMENT_EXTS = new Set(['pdf', 'docx', 'doc', 'txt', 'csv']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'webm']);

function extOf(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i + 1).toLowerCase();
}

function pathFor(kind) { return kind === 'document' ? 'sourceDocuments' : 'evidenceItems'; }

// Retries only the transfer step (the one actually exposed to a flaky mobile
// connection) — not the cheap upload-url/confirm calls around it. Retries on
// network failure or a 5xx (transient); never on 4xx (retrying won't help a
// validation/auth rejection).
async function withRetry(fn, { attempts = 3, delaysMs = [500, 1500, 4000] } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      if (result && result.status >= 500) throw Object.assign(new Error(`Server error ${result.status}`), { retryableStatus: true });
      return result;
    } catch (err) {
      lastErr = err;
      if (!err.networkError && !err.retryableStatus) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delaysMs[i] || 4000));
    }
  }
  throw lastErr;
}

// Signed-URL support is a deployment-wide, unchanging fact (STORAGE_DRIVER
// is set once at boot, not per-request) — once one call 501s
// (direct_upload_unsupported), every subsequent upload this session would
// too. Remembering it avoids re-probing an endpoint already known to be a
// dead end for every file after the first.
let presignedUnsupported = false;

async function uploadViaPresigned({ projectId, file, kind, documentType, onProgress }) {
  const urlPath = pathFor(kind);
  let grant;
  try {
    grant = await apiJson(`/projects/${projectId}/${urlPath}/upload-url`, {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream' }),
    });
  } catch (err) {
    if (err.status === 501) { const e = new Error('direct_upload_unsupported'); e.code = 'direct_upload_unsupported'; throw e; }
    throw err;
  }
  // The presigned PUT targets an external GCS/S3 URL, never this app's own
  // API — no CSRF header, no credentials (xhrRequest, not apiFetchXhr).
  const putHeaders = { 'Content-Type': file.type || 'application/octet-stream', ...(grant.headers || {}) };
  const put = await withRetry(() => xhrRequest({
    method: grant.method || 'PUT', url: grant.uploadUrl, headers: putHeaders, body: file, onProgress,
  }));
  if (put.status < 200 || put.status >= 300) throw new Error(`Upload to storage failed (HTTP ${put.status})`);

  const confirmBody = kind === 'document'
    ? { stagingKey: grant.stagingKey, originalFilename: file.name, document_type: documentType }
    : { stagingKey: grant.stagingKey, originalFilename: file.name };
  return apiJson(`/projects/${projectId}/${urlPath}/confirm-upload`, { method: 'POST', body: JSON.stringify(confirmBody) });
}

async function uploadViaMultipart({ projectId, file, kind, documentType, onProgress }) {
  const urlPath = pathFor(kind);
  const form = new FormData();
  form.append('file', file);
  if (kind === 'document') form.append('document_type', documentType);
  // apiFetchXhr (not raw xhrRequest) — this IS a call to this app's own
  // API, so it needs the same CSRF header + 401-refresh-retry every other
  // authenticated call gets, not a thinner hand-rolled copy of it.
  const res = await withRetry(() => apiFetchXhr(`/projects/${projectId}/${urlPath}`, { method: 'POST', body: form, onProgress }));
  if (res.status < 200 || res.status >= 300) {
    throw new Error((res.body && res.body.error) || `Upload failed (HTTP ${res.status})`);
  }
  return res.body;
}

async function uploadOne({ projectId, file, kind, documentType, onProgress }) {
  if (!presignedUnsupported) {
    try {
      return await uploadViaPresigned({ projectId, file, kind, documentType, onProgress });
    } catch (err) {
      if (err.code !== 'direct_upload_unsupported') throw err;
      presignedUnsupported = true;
    }
  }
  return uploadViaMultipart({ projectId, file, kind, documentType, onProgress });
}

const DOCUMENT_TYPES = ['contract', 'estimate', 'change_order', 'invoice', 'other'];

function FileRow({ item, onRetry }) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
      <span className="flex-1 truncate">{item.file.name}</span>
      {item.state === 'uploading' && (
        <span className="w-24 text-right text-muted-foreground">{Math.round(item.progress * 100)}%</span>
      )}
      {item.state === 'done' && <span className="text-green-600">Uploaded</span>}
      {item.state === 'error' && (
        <>
          <span className="text-destructive" title={item.error}>Failed</span>
          <Button type="button" variant="outline" onClick={() => onRetry(item.id)}>Retry</Button>
        </>
      )}
    </li>
  );
}

/**
 * The dashboard's only real evidence-capture UI. Before this component,
 * every upload endpoint (multipart AND signed-URL, both fully built and
 * tested server-side — see routes/evidence.js) was unreachable from the
 * app: the generic entity-CRUD forms only let a user type a raw storage_uri
 * string, which is meaningless for a real upload. See TODO.md "mobile
 * capture UX + upload resume."
 *
 * Tries the direct-to-storage signed-URL path first (keeps large field
 * photos/videos off this server's own memory); falls back to the proxied
 * multipart endpoint automatically on a 501 (`direct_upload_unsupported`,
 * returned whenever STORAGE_DRIVER isn't gcs/s3 — e.g. every local/demo
 * deployment) — so this widget works in every deployment mode without the
 * user ever knowing which path was used.
 */
export default function EvidenceUpload({ onUploaded }) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [documentType, setDocumentType] = useState(DOCUMENT_TYPES[0]);
  const [items, setItems] = useState([]); // { id, file, kind, state, progress, error }
  const docInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    apiJson('/projectRecords')
      .then((d) => setProjects(Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : [])))
      .catch(() => setProjects([]));
  }, []);

  // Only used to infer a kind for entry points with no way to state intent
  // (drag-and-drop, the generic "Add Photo / Audio / Receipt" button) — a
  // document extension here means "receipt-as-evidence" (evidenceItems,
  // no document_type), deliberately DIFFERENT from the explicit "Upload
  // Document" button below (kind: 'document', sourceDocuments,
  // contract-baseline extraction). Both are real, legitimate ways to record
  // the same file type; this default just picks the lower-consequence one
  // when the user hasn't said which they mean.
  function classify(file) {
    const ext = extOf(file.name);
    if (IMAGE_EXTS.has(ext)) return 'photo';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    if (DOCUMENT_EXTS.has(ext)) return 'receipt';
    return null;
  }

  function runUpload(id, file, kind) {
    setItems((s) => s.map((it) => (it.id === id ? { ...it, state: 'uploading', progress: 0, error: null } : it)));
    uploadOne({
      projectId, file, kind, documentType,
      onProgress: (p) => setItems((s) => s.map((it) => (it.id === id ? { ...it, progress: p } : it))),
    }).then(() => {
      setItems((s) => s.map((it) => (it.id === id ? { ...it, state: 'done', progress: 1 } : it)));
      // Only the table that actually changed refetches — 'document' kind
      // maps to sourceDocuments, everything else to evidenceItems (see
      // pathFor above) — not both, on every single upload.
      onUploaded && onUploaded(kind === 'document' ? 'sourceDocument' : 'evidenceItem');
    }).catch((err) => {
      setItems((s) => s.map((it) => (it.id === id ? { ...it, state: 'error', error: err.message } : it)));
    });
  }

  function addFiles(fileList, kind) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!projectId) { window.alert('Choose a project first.'); return; }
    const classified = files
      .map((file) => ({
        id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file, kind: kind || classify(file), state: 'pending', progress: 0, error: null,
      }))
      .filter((it) => it.kind);
    setItems((s) => [...classified, ...s]);
    for (const it of classified) runUpload(it.id, it.file, it.kind);
  }

  function retry(id) {
    const target = items.find((it) => it.id === id);
    if (target) runUpload(id, target.file, target.kind);
  }

  function onDrop(e) {
    e.preventDefault();
    addFiles(e.dataTransfer.files, null);
  }

  return (
    <div className="mb-6 rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-lg font-semibold text-foreground">Capture evidence</h2>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-sm text-muted-foreground" htmlFor="evidence-upload-project">Project</label>
        <select
          id="evidence-upload-project" className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={projectId} onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">Select a project…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
        className="mb-3 rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground"
      >
        Drag and drop files here, or use a button below
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {/* capture="environment" opens the rear camera directly on mobile;
            ignored (falls back to a normal file picker) on desktop. */}
        <Button type="button" onClick={() => photoInputRef.current && photoInputRef.current.click()}>Take Photo</Button>
        <input ref={photoInputRef} type="file" accept="image/*" capture="environment" hidden
          onChange={(e) => { addFiles(e.target.files, 'photo'); e.target.value = ''; }} />

        <Button type="button" variant="outline" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
          Add Photo / Audio / Receipt
        </Button>
        <input ref={fileInputRef} type="file" multiple hidden
          accept="image/*,audio/*,.pdf,.docx,.doc,.txt,.csv"
          onChange={(e) => { addFiles(e.target.files, null); e.target.value = ''; }} />

        <select
          className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={documentType} onChange={(e) => setDocumentType(e.target.value)}
          aria-label="Document type"
        >
          {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
        </select>
        <Button type="button" variant="outline" onClick={() => docInputRef.current && docInputRef.current.click()}>
          Upload Document
        </Button>
        <input ref={docInputRef} type="file" multiple hidden
          accept=".pdf,.docx,.doc,.txt,.csv"
          onChange={(e) => { addFiles(e.target.files, 'document'); e.target.value = ''; }} />
      </div>

      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((it) => <FileRow key={it.id} item={it} onRetry={retry} />)}
        </ul>
      )}
    </div>
  );
}
