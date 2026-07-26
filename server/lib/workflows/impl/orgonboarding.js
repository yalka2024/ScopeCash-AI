'use strict';

const realImplemented = true;

// stepIndex (0-based) -> async (state, ctx) => string | JSON-serializable
const steps = {};

/**
 * Step 0: Create organization with legal name, trade types, timezone, and address.
 * Validates and normalises the org-creation payload from state, returning a
 * structured org record ready for persistence.
 */
steps[0] = async (state, ctx) => {
  let input = {};
  try { input = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const org = {
    legalName:  (input.legalName  || input.legal_name  || '').trim(),
    tradeTypes: Array.isArray(input.tradeTypes) ? input.tradeTypes
                : (input.tradeTypes ? String(input.tradeTypes).split(',').map(s => s.trim()) : []),
    timezone:   (input.timezone   || 'UTC').trim(),
    address: {
      line1:   (input.address?.line1   || input.addressLine1   || '').trim(),
      line2:   (input.address?.line2   || input.addressLine2   || '').trim(),
      city:    (input.address?.city    || input.city           || '').trim(),
      state:   (input.address?.state   || input.state          || '').trim(),
      zip:     (input.address?.zip     || input.zip            || '').trim(),
      country: (input.address?.country || input.country        || 'US').trim(),
    },
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  const warnings = [];
  if (!org.legalName)           warnings.push('legalName is required');
  if (!org.tradeTypes.length)   warnings.push('at least one tradeType is recommended');
  if (!org.address.line1)       warnings.push('address.line1 is recommended');

  return JSON.stringify({ org, warnings, step: 'org_created' });
};

/**
 * Step 1: Configure default markup, tax rate, currency, and retention policy.
 * Merges financial configuration onto the org record from step 0.
 */
steps[1] = async (state, ctx) => {
  let input = {};
  try { input = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const org = input.org || {};

  // Clamp percentages to [0, 100], default sensible values.
  const clampPct = (val, def) => {
    const n = parseFloat(val);
    if (isNaN(n)) return def;
    return Math.min(100, Math.max(0, n));
  };

  const financials = {
    defaultMarkupPct:    clampPct(input.defaultMarkupPct    ?? input.markup,    15),
    taxRatePct:          clampPct(input.taxRatePct          ?? input.taxRate,    0),
    currency:            (input.currency || 'USD').toUpperCase().slice(0, 3),
    retentionPolicy: {
      retentionPct:      clampPct(input.retentionPct        ?? input.retention,  10),
      releaseCondition:  (input.releaseCondition || 'final_completion').trim(),
    },
  };

  const updatedOrg = Object.assign({}, org, { financials, financialsConfiguredAt: new Date().toISOString() });

  return JSON.stringify({ org: updatedOrg, step: 'financials_configured' });
};

/**
 * Step 2: Invite team members and assign roles.
 * Validates each member entry and builds an invitation manifest.
 */
steps[2] = async (state, ctx) => {
  let input = {};
  try { input = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const VALID_ROLES = new Set(['owner', 'admin', 'estimator', 'field', 'viewer']);

  const rawMembers = Array.isArray(input.members) ? input.members : [];

  const invitations = rawMembers.map((m, i) => {
    const email = (m.email || '').trim().toLowerCase();
    const role  = VALID_ROLES.has(m.role) ? m.role : 'viewer';
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    return {
      index: i,
      email,
      role,
      name:   (m.name || '').trim(),
      valid,
      status: valid ? 'invited' : 'invalid_email',
      invitedAt: valid ? new Date().toISOString() : null,
    };
  });

  const org = input.org || {};
  const updatedOrg = Object.assign({}, org, {
    teamInvitationsAt: new Date().toISOString(),
  });

  return JSON.stringify({
    org: updatedOrg,
    invitations,
    validCount:   invitations.filter(i => i.valid).length,
    invalidCount: invitations.filter(i => !i.valid).length,
    step: 'team_invited',
  });
};

/**
 * Step 3: Upload optional rate sheet.
 * Parses and validates a rate sheet payload (rows of labor/material rates).
 * Treats missing rate sheet as a no-op — fully optional.
 */
steps[3] = async (state, ctx) => {
  let input = {};
  try { input = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const rawRates = Array.isArray(input.rateSheet) ? input.rateSheet : [];

  const rateSheet = rawRates.map((row, i) => {
    const rate = parseFloat(row.rate ?? row.unitCost ?? 0);
    return {
      index:       i,
      description: (row.description || row.name || `Rate ${i + 1}`).trim(),
      unit:        (row.unit || 'hr').trim(),
      rate:        isNaN(rate) ? 0 : Math.max(0, rate),
      category:    (row.category || 'labor').trim(),
      valid:       !isNaN(rate) && rate >= 0,
    };
  });

  const org = input.org || {};
  const updatedOrg = Object.assign({}, org, {
    rateSheetUploadedAt: rateSheet.length ? new Date().toISOString() : null,
  });

  return JSON.stringify({
    org: updatedOrg,
    rateSheet,
    rateCount: rateSheet.length,
    skipped:   rateSheet.length === 0,
    step: 'rate_sheet_uploaded',
  });
};

/**
 * Step 4: Complete consent and AI-limitations acknowledgment.
 * Records explicit user acknowledgments; blocks progression if required
 * consents are absent.
 */
steps[4] = async (state, ctx) => {
  let input = {};
  try { input = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const consent = input.consent || {};

  const required = [
    'termsOfService',
    'privacyPolicy',
    'aiLimitationsAcknowledged',
  ];

  const acknowledgments = {};
  const missing = [];

  for (const key of required) {
    const accepted = consent[key] === true || consent[key] === 'true' || consent[key] === 1;
    acknowledgments[key] = { accepted, timestamp: accepted ? new Date().toISOString() : null };
    if (!accepted) missing.push(key);
  }

  const consentComplete = missing.length === 0;
  const org = input.org || {};
  const updatedOrg = Object.assign({}, org, {
    consentComplete,
    consentRecordedAt: consentComplete ? new Date().toISOString() : null,
    status: consentComplete ? 'active' : 'pending_consent',
  });

  return JSON.stringify({
    org: updatedOrg,
    acknowledgments,
    consentComplete,
    missing,
    step: 'consent_recorded',
    ...(consentComplete ? {} : { error: 'Required consents not completed', blockedOn: missing }),
  });
};

/**
 * Step 5: Create first project.
 * Scaffolds a minimal project record tied to the org.
 */
steps[5] = async (state, ctx) => {
  let input = {};
  try { input = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const org = input.org || {};

  // If consent was not completed, surface a clear error rather than creating a project.
  if (org.consentComplete === false) {
    return JSON.stringify({
      error: 'Cannot create project: consent not completed',
      org,
      step: 'first_project_blocked',
    });
  }

  const project = {
    name:        (input.projectName  || input.project?.name  || 'First Project').trim(),
    description: (input.projectDescription || input.project?.description || '').trim(),
    orgId:       org.legalName || 'unknown',
    currency:    org.financials?.currency || 'USD',
    status:      'draft',
    tradeTypes:  org.tradeTypes || [],
    createdAt:   new Date().toISOString(),
    lineItems:   [],
    totals: {
      subtotal:  0,
      markupAmt: 0,
      taxAmt:    0,
      retention: 0,
      total:     0,
    },
  };

  const updatedOrg = Object.assign({}, org, {
    firstProjectCreatedAt: new Date().toISOString(),
    status: 'active',
  });

  return JSON.stringify({
    org: updatedOrg,
    project,
    step: 'first_project_created',
    onboardingComplete: true,
  });
};

module.exports = { realImplemented, steps, workflow: "OrgOnboarding" };
