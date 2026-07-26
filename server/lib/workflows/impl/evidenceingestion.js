'use strict';

const crypto = require('crypto');
const path = require('path');

const realImplemented = true;

// stepIndex (0-based) -> async (state, ctx) => string | JSON-serializable
const steps = {};

/**
 * Step 0: Accept drag-drop or mobile camera/voice upload; validate file type, size, and path
 * Deterministically validates file metadata present in state.
 * Expected state (JSON): { fileName, fileSize, mimeType, filePath? }
 */
steps[0] = async (state, ctx) => {
  let input = {};
  try { input = JSON.parse(state || '{}'); } catch (_) { input = {}; }

  const ALLOWED_MIME_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff',
    'application/pdf',
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm',
    'video/mp4', 'video/webm', 'video/quicktime',
    'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]);

  const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

  const DANGEROUS_EXTENSIONS = new Set([
    '.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js', '.jar',
    '.msi', '.dll', '.so', '.dylib', '.php', '.py', '.rb', '.pl',
  ]);

  const errors = [];
  const warnings = [];

  const { fileName = '', fileSize = 0, mimeType = '', filePath = '' } = input;

  // Validate fileName
  if (!fileName || typeof fileName !== 'string' || fileName.trim() === '') {
    errors.push('fileName is required and must be a non-empty string.');
  } else {
    const ext = path.extname(fileName).toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      errors.push(`File extension "${ext}" is not permitted for security reasons.`);
    }
    // Path traversal guard
    const normalized = path.normalize(fileName);
    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      errors.push('fileName must not contain path traversal sequences or be an absolute path.');
    }
  }

  // Validate fileSize
  if (typeof fileSize !== 'number' || fileSize <= 0) {
    errors.push('fileSize must be a positive number (bytes).');
  } else if (fileSize > MAX_FILE_SIZE_BYTES) {
    errors.push(`fileSize ${fileSize} exceeds maximum allowed size of ${MAX_FILE_SIZE_BYTES} bytes (500 MB).`);
  } else if (fileSize < 1) {
    errors.push('fileSize must be at least 1 byte; empty files are not accepted.');
  }

  // Validate mimeType
  if (!mimeType || typeof mimeType !== 'string' || mimeType.trim() === '') {
    errors.push('mimeType is required.');
  } else if (!ALLOWED_MIME_TYPES.has(mimeType.toLowerCase().split(';')[0].trim())) {
    errors.push(`mimeType "${mimeType}" is not in the list of permitted types.`);
  }

  // Validate optional filePath
  if (filePath && typeof filePath === 'string') {
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..')) {
      errors.push('filePath must not contain path traversal sequences.');
    }
  }

  const valid = errors.length === 0;

  const result = {
    step: 'validate_upload',
    valid,
    errors,
    warnings,
    meta: {
      fileName: fileName || null,
      fileSize: fileSize || null,
      mimeType: mimeType || null,
      filePath: filePath || null,
      validatedAt: new Date().toISOString(),
    },
  };

  if (!valid) {
    result.status = 'REJECTED';
  } else {
    result.status = 'ACCEPTED';
  }

  return result;
};

/**
 * Step 2: Compute SHA-256 hash; reject exact duplicates with notice
 * Deterministically computes SHA-256 from fileContent (base64 or hex) or
 * falls back to hashing available metadata. Checks against knownHashes list
 * provided in state.
 * Expected state (JSON): { fileContent?, fileContentEncoding?, knownHashes?, meta? }
 */
steps[2] = async (state, ctx) => {
  let input = {};
  try { input = JSON.parse(state || '{}'); } catch (_) { input = {}; }

  const {
    fileContent = null,
    fileContentEncoding = 'base64', // 'base64' | 'hex' | 'utf8'
    knownHashes = [],               // array of previously stored SHA-256 hex strings
    meta = {},
  } = input;

  let hash = null;
  let hashSource = null;

  if (fileContent && typeof fileContent === 'string') {
    try {
      const buf = Buffer.from(fileContent, fileContentEncoding || 'base64');
      hash = crypto.createHash('sha256').update(buf).digest('hex');
      hashSource = 'fileContent';
    } catch (e) {
      // Fall through to metadata hash
    }
  }

  if (!hash) {
    // Deterministic fallback: hash stable metadata
    const metaStr = JSON.stringify({
      fileName: meta.fileName || '',
      fileSize: meta.fileSize || 0,
      mimeType: meta.mimeType || '',
    });
    hash = crypto.createHash('sha256').update(metaStr, 'utf8').digest('hex');
    hashSource = 'metadata_fallback';
  }

  const safeKnownHashes = Array.isArray(knownHashes) ? knownHashes : [];
  const isDuplicate = safeKnownHashes.includes(hash);

  const result = {
    step: 'compute_hash',
    sha256: hash,
    hashSource,
    isDuplicate,
    status: isDuplicate ? 'DUPLICATE_REJECTED' : 'HASH_OK',
    computedAt: new Date().toISOString(),
  };

  if (isDuplicate) {
    result.notice = `A file with SHA-256 hash ${hash} already exists in the system. Upload rejected to prevent exact duplicates.`;
  }

  return result;
};

/**
 * Step 4: Extract derivative text previews and thumbnail metadata
 * Deterministically extracts text snippets and generates thumbnail metadata
 * from the file information available in state (no external I/O).
 * Expected state (JSON): { fileName, mimeType, fileSize, fileContent?, sha256? }
 */
steps[4] = async (state, ctx) => {
  let input = {};
  try { input = JSON.parse(state || '{}'); } catch (_) { input = {}; }

  const {
    fileName = '',
    mimeType = '',
    fileSize = 0,
    fileContent = null,
    fileContentEncoding = 'base64',
    sha256 = null,
  } = input;

  const normalizedMime = (mimeType || '').toLowerCase().split(';')[0].trim();

  let textPreview = null;
  let thumbnailMeta = null;
  const extractedAt = new Date().toISOString();

  // Text extraction (deterministic, no external deps)
  if (normalizedMime === 'text/plain' || normalizedMime === 'text/csv') {
    if (fileContent) {
      try {
        const decoded = Buffer.from(fileContent, fileContentEncoding || 'base64').toString('utf8');
        // Preview: first 500 characters
        textPreview = decoded.slice(0, 500);
        if (decoded.length > 500) textPreview += '…';
      } catch (_) {
        textPreview = '[Text extraction failed: invalid encoding]';
      }
    } else {
      textPreview = '[Text content not provided in state; extraction deferred to processing pipeline]';
    }
  } else if (normalizedMime === 'application/pdf') {
    textPreview = '[PDF text extraction requires server-side processing; queued for Gemini pipeline]';
  } else if (normalizedMime.startsWith('image/')) {
    textPreview = '[Image file; text extraction via OCR deferred to Gemini processing]';
  } else if (normalizedMime.startsWith('audio/') || normalizedMime.startsWith('video/')) {
    textPreview = '[Audio/video file; transcription deferred to Gemini processing]';
  } else {
    textPreview = '[Text extraction not available for this file type]';
  }

  // Thumbnail metadata generation (deterministic)
  const ext = path.extname(fileName).toLowerCase();
  let thumbnailType = 'generic';
  if (normalizedMime.startsWith('image/')) thumbnailType = 'image';
  else if (normalizedMime === 'application/pdf') thumbnailType = 'pdf_cover';
  else if (normalizedMime.startsWith('video/')) thumbnailType = 'video_frame';
  else if (normalizedMime.startsWith('audio/')) thumbnailType = 'audio_waveform';
  else if (['.doc', '.docx'].includes(ext)) thumbnailType = 'document';
  else if (['.xls', '.xlsx'].includes(ext)) thumbnailType = 'spreadsheet';
  else if (normalizedMime === 'text/csv') thumbnailType = 'spreadsheet';
  else if (normalizedMime === 'text/plain') thumbnailType = 'text_document';

  thumbnailMeta = {
    thumbnailType,
    generationStrategy: thumbnailType === 'image' ? 'resize_and_crop' : 'icon_overlay',
    suggestedDimensions: { width: 256, height: 256 },
    format: 'webp',
    requiresServerRender: thumbnailType !== 'generic',
    storageKey: sha256 ? `thumbnails/${sha256}_256x256.webp` : null,
  };

  return {
    step: 'extract_derivatives',
    status: 'DERIVATIVES_READY',
    textPreview,
    thumbnailMeta,
    fileSummary: {
      fileName,
      mimeType: normalizedMime,
      fileSize,
      sha256,
    },
    extractedAt,
  };
};

/**
 * Step 6: Poll and surface processing status, progress events, and errors to UI
 * Deterministically maps processing state from previous pipeline steps into
 * a structured UI-ready status payload.
 * Expected state (JSON): { processingJobId?, status?, progress?, errors?, steps? }
 */
steps[6] = async (state, ctx) => {
  let input = {};
  try { input = JSON.parse(state || '{}'); } catch (_) { input = {}; }

  const {
    processingJobId = null,
    status = 'UNKNOWN',
    progress = null,        // 0-100 or null
    errors = [],
    completedSteps = [],
    sha256 = null,
    fileName = null,
  } = input;

  const safeErrors = Array.isArray(errors) ? errors : [];
  const safeCompletedSteps = Array.isArray(completedSteps) ? completedSteps : [];

  // Derive a canonical status category
  const STATUS_MAP = {
    PENDING: { label: 'Pending', uiColor: 'gray', uiIcon: 'clock', terminal: false },
    QUEUED: { label: 'Queued for Processing', uiColor: 'blue', uiIcon: 'queue', terminal: false },
    PROCESSING: { label: 'Processing', uiColor: 'yellow', uiIcon: 'spinner', terminal: false },
    COMPLETED: { label: 'Completed', uiColor: 'green', uiIcon: 'check', terminal: true },
    FAILED: { label: 'Failed', uiColor: 'red', uiIcon: 'x', terminal: true },
    DUPLICATE_REJECTED: { label: 'Duplicate Rejected', uiColor: 'orange', uiIcon: 'warning', terminal: true },
    REJECTED: { label: 'Rejected', uiColor: 'red', uiIcon: 'ban', terminal: true },
    UNKNOWN: { label: 'Unknown', uiColor: 'gray', uiIcon: 'question', terminal: false },
  };

  const statusMeta = STATUS_MAP[status] || STATUS_MAP['UNKNOWN'];

  // Build progress events list
  const progressEvents = safeCompletedSteps.map((stepName, i) => ({
    sequence: i + 1,
    event: stepName,
    status: 'COMPLETED',
  }));

  if (statusMeta.terminal && !progressEvents.find(e => e.event === status)) {
    progressEvents.push({
      sequence: progressEvents.length + 1,
      event: status,
      status,
    });
  }

  // UI error surface
  const uiErrors = safeErrors.map((err, i) => ({
    index: i,
    message: typeof err === 'string' ? err : (err.message || JSON.stringify(err)),
    severity: 'ERROR',
  }));

  const uiPayload = {
    step: 'surface_status',
    processingJobId,
    sha256,
    fileName,
    status,
    statusLabel: statusMeta.label,
    uiColor: statusMeta.uiColor,
    uiIcon: statusMeta.uiIcon,
    isTerminal: statusMeta.terminal,
    progressPercent: typeof progress === 'number'
      ? Math.min(100, Math.max(0, Math.round(progress)))
      : (statusMeta.terminal ? (status === 'COMPLETED' ? 100 : null) : null),
    progressEvents,
    errors: uiErrors,
    hasErrors: uiErrors.length > 0,
    polledAt: new Date().toISOString(),
    message: uiErrors.length > 0
      ? `Processing encountered ${uiErrors.length} error(s). See errors array for details.`
      : `${statusMeta.label}${typeof progress === 'number' ? ` — ${Math.round(progress)}%` : ''}.`,
  };

  return uiPayload;
};

module.exports = { realImplemented, steps, workflow: "EvidenceIngestion" };
