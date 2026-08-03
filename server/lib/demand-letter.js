/**
 * Payment demand letters — composition and the safety rules that constrain it.
 *
 * A contractor finishes approved change-order work, invoices it, and doesn't
 * get paid. This composes the letter they send about that, from facts the
 * product already holds: the approval, the completion date, the photo evidence
 * with capture timestamps, the invoice, the days outstanding.
 *
 * WHAT THIS DELIBERATELY IS NOT
 *
 * It is not legal advice, and the whole design exists to keep it from becoming
 * legal advice by accident. Three US legal regimes bite here, and each one
 * dictated a specific structural choice rather than a paragraph of disclaimer:
 *
 * 1. UNAUTHORIZED PRACTICE OF LAW. Applying law to a specific person's facts
 *    is the line (N.C. State Bar v. Lienguard, 2014 NCBC 11 — a web service
 *    that prepared mechanics liens AND demand letters, enjoined; the court
 *    counted its deadline warnings and lien-law definitions as part of the
 *    violation). So: this letter states facts and never cites a statute, never
 *    asserts what the recipient legally owes, and never computes a lien or
 *    prompt-payment deadline. Deadline computation is the single most
 *    enjoinable feature we could add and we are not adding it.
 *
 * 2. 15 U.S.C. 1692j — "flat-rating" — reaches whoever DESIGNS and FURNISHES
 *    a form knowing it will create the false belief that someone other than
 *    the creditor is participating in collection. That is a direct liability
 *    on the software vendor, not on the contractor, and it is why
 *    `assertNoVendorBranding()` exists and is called on the rendered output.
 *    The generic packet disclaimer says "generated automatically by ScopeCash
 *    AI" (lib/tools/pdfpacketrenderer.js); on a demand letter that sentence is
 *    the violation, so this letter carries its own footer and that block must
 *    never be rendered into it.
 *
 * 3. FDCPA 1692e / state analogues (Cal. Rosenthal Act, Tex. Fin. Code ch.
 *    392, Fla. FCCPA and others reach FIRST-party creditors, unlike the
 *    federal act). Hence PROHIBITED_CONTENT below and the closed
 *    INTENDED_ACTIONS list: threatened consequences are an enum the contractor
 *    picks from, never free text, because the extortion line (Flatley v.
 *    Mauro, 39 Cal. 4th 299) turns on whether the threatened act is one the
 *    sender may lawfully take AND is connected to the claim.
 *
 * The attestations are the real protection, not the disclaimer. They make the
 * contractor the author of their own communication — which is both the UPL
 * answer and the 1692e(5) answer, since "threat of action not intended" is
 * only a violation if the action was not in fact intended.
 *
 * This module is pure: no database, no I/O, no clock of its own. Everything it
 * needs is passed in, so all of it is testable.
 */

/**
 * Who the letter is going to. This changes the legal ruleset, not the tone.
 *
 * Federal FDCPA "debt" means an obligation incurred primarily for personal,
 * family or household purposes (15 U.S.C. 1692a(5)) — so residential work for
 * a homeowner is consumer debt and a commercial GC's balance generally is not.
 * California SB 1286 (effective 2025-07-01) then pulls commercial debt of
 * <= $500k owed by a NATURAL PERSON back into Rosenthal, which is why this is
 * a property of the recipient rather than of the project.
 */
const RECIPIENT_TYPES = {
  homeowner: {
    label: 'Homeowner / residential customer',
    consumer: true,
  },
  commercial: {
    label: 'General contractor / commercial entity',
    // Not consumer debt federally. We still apply the same content rules —
    // the prohibitions below are about not lying and not threatening, which
    // is not a standard worth relaxing because the recipient is a company.
    consumer: false,
  },
};

/**
 * The only consequences a generated letter may mention.
 *
 * Closed set, deliberately. Free text here is how a letter becomes extortion
 * or a 1692e(5) threat, and no amount of screening catches every phrasing.
 * Each entry needs `requiresAffirmation` — the contractor must separately
 * confirm both that the right exists and that they intend to exercise it,
 * because a threat of action not actually intended is itself the violation.
 *
 * Everything NOT on this list is off it for a reason. Reporting to a licensing
 * board, to a lender, to the AG, to tax or immigration authorities; contacting
 * the recipient's other customers; posting reviews — all are threats to
 * inflict harm unconnected to the underlying claim, which is the Flatley
 * fact pattern.
 */
const INTENDED_ACTIONS = {
  suspend_work: {
    label: 'Suspend further work on this project',
    sentence: 'we intend to suspend further work on this project',
    requiresAffirmation: 'I have the contractual right to suspend work for non-payment.',
  },
  civil_suit: {
    label: 'File a civil suit for breach of contract',
    sentence: 'we intend to file suit for breach of contract',
    requiresAffirmation: 'I intend to file suit if this is not resolved.',
  },
  lien_or_bond_claim: {
    // Note what this does NOT do: it does not tell the contractor whether they
    // still have lien rights, or by when. That determination is theirs (or
    // their lawyer's). We only repeat an intention they affirmed.
    label: 'Pursue a mechanics lien or bond claim',
    sentence: 'we intend to pursue the remedies available to us, which may include a mechanics lien or bond claim',
    requiresAffirmation: 'I have confirmed with my own counsel that these rights are available to me and are not expired.',
  },
  contract_remedies: {
    label: 'Pursue remedies under the contract',
    sentence: 'we intend to pursue our remedies under the contract',
    requiresAffirmation: 'The contract provides remedies for non-payment.',
  },
};

/**
 * Content that must never reach a generated letter, checked against every
 * free-text field the contractor can influence.
 *
 * Each rule carries `why` because a rejection the user does not understand
 * gets worked around — they retype it another way and we have achieved
 * nothing. The message has to explain the actual risk.
 */
const PROHIBITED_CONTENT = [
  {
    id: 'attorney_implication',
    // 1692e(3), Cal. Civ. Code 1788.13(b)-(c), and 1692j for us specifically.
    pattern: /\b(attorney|lawyer|law\s*(firm|office|group|dept|department)|legal\s+(department|dept|counsel|action\s+notice)|esq\.?|counsel(?:or)?\s+at\s+law|final\s+legal\s+notice|legal\s+notice)\b/i,
    why: 'Implying a lawyer is involved when none is makes this letter unlawful in several states and exposes you personally. If a lawyer IS involved, they should send the letter on their own letterhead.',
  },
  {
    id: 'government_implication',
    // 1692e(1),(9),(13); FTC Impersonation Rule, 16 C.F.R. pt. 461.
    pattern: /\b(official\s+notice|docket\s*(no|number|#)|court\s+order|summons|subpoena|federal\s+(agency|bureau)|state\s+(agency|bureau)\s+notice)\b/i,
    why: 'Language that makes a private letter look like a court or government document is separately illegal, even when everything it says is true.',
  },
  {
    id: 'criminal_accusation',
    // 1692e(4),(7). The construction-specific version — accusing a GC of
    // misapplying trust funds — is the most dangerous sentence this product
    // could produce: it is a 1692e(7) false-crime implication, criminal
    // extortion under Cal. Penal Code 519, AND unauthorized practice of law,
    // all at once. It is common enough in real contractor correspondence to
    // be worth naming explicitly rather than hoping the generic pattern hits.
    // Note the `funds?` and the absence of a trailing \b on the trust-fund
    // alternatives: an earlier version ended them at `trust\s+fund` inside a
    // `\b(...)\b` wrapper, so "trust funds" — the way anyone actually writes
    // it — failed the closing boundary against the plural 's' and the whole
    // rule silently never fired. A screening rule that matches nothing is
    // worse than no rule, because it reads as coverage.
    pattern: /\b(theft|stolen|steal(ing)?|fraud(ulent)?|embezzl\w*|criminal(ly)?|prosecut\w*|press\s+charges|report\s+you\s+to\s+the\s+(police|authorities|da|district\s+attorney))\b|\b(misappl|divert)\w*\s+[^.]{0,20}?trust\s+funds?/i,
    why: 'Threatening criminal consequences to collect a civil debt is extortion in most states — it can void your claim and expose you to criminal liability, regardless of whether the underlying debt is real.',
  },
  {
    id: 'credit_reporting',
    // 1692e(8),(10). Also just false: civil judgments and tax liens were
    // removed from all three national CRAs by April 2018 under the National
    // Consumer Assistance Plan, so "this will hurt your credit" is now an
    // affirmatively untrue statement of fact rather than merely a threat.
    pattern: /\b(credit\s+(report|score|bureau|rating)|equifax|experian|transunion|collections?\s+agency|charge[\s-]?off)\b/i,
    why: 'You are almost certainly not a credit furnisher, and liens and judgments have not appeared on consumer credit reports since 2018 — so this is a false statement of fact, not just a threat.',
  },
  {
    id: 'coercive_third_party',
    // Flatley v. Mauro / Falcon Brands: threatening a harm with no logical
    // nexus to the claim is what converts a settlement demand into extortion.
    pattern: /\b(licensing\s+board|contractor'?s?\s+license|attorney\s+general|\bBBB\b|better\s+business\s+bureau|(yelp|google)\s+review|social\s+media|tell\s+your\s+(neighbors|lender|insurer)|notify\s+your\s+(lender|insurer|hoa))\b/i,
    why: 'Threatening consequences unrelated to this specific debt — licensing complaints, reviews, telling third parties — is the line courts use to separate a lawful demand from extortion.',
  },
  {
    id: 'statutory_citation',
    // UPL. Selecting which law applies to these facts is the practice of law;
    // reciting one you were handed is not, but we cannot tell those apart at
    // generation time, so neither is allowed in the letter body.
    // Deliberately keyed on legal-code vocabulary rather than on "section
    // <number>", which would also catch "section 4 of our contract" — a
    // perfectly ordinary and useful thing for a contractor to reference.
    pattern: /\b(\d+\s*U\.?\s?S\.?\s?C\.?\b|C\.?F\.?R\.?\s*(§|part|\d)|(rev(ised)?|gen(eral)?|civ(il)?|penal|business|labor|finance|admin(istrative)?)\.?\s+code\b|stat(utes?)?\.?\s*ann\b|statut(e|es|ory)\b|§|pursuant\s+to\s+(section|statute|chapter)|under\s+(state|federal)\s+law)/i,
    why: 'We cannot cite statutes for you — deciding which law applies to your situation is legal advice, and software is not permitted to give it. State the facts; if the law matters here, a lawyer should be the one invoking it.',
  },
];

const REQUIRED_ATTESTATIONS = [
  { id: 'has_written_authorization', text: 'I have a written contract or written approval for the work described.' },
  { id: 'work_completed',            text: 'The work described has been completed.' },
  { id: 'amount_accurate',           text: 'The amount stated is accurate and is currently past due.' },
  { id: 'intends_actions',           text: 'I intend to take every action described in this letter.' },
  { id: 'reviewed_and_adopts',       text: 'I have read this letter in full and approve it as my own communication.' },
];

/** Vendor identifiers that must never appear on a letter. See 1692j above. */
const VENDOR_MARKERS = /\b(scopecash|scope\s?cash)\b/i;

class DemandLetterError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'DemandLetterError';
    this.code = code;
    this.status = 400;
    this.details = details;
  }
}

/**
 * Screen contractor-supplied free text. Returns every violation rather than
 * the first, so someone fixing a paragraph is told everything wrong with it
 * instead of discovering the problems one submit at a time.
 */
function screenText(text, fieldName = 'text') {
  const violations = [];
  if (text == null || text === '') return { ok: true, violations };
  const s = String(text);
  for (const rule of PROHIBITED_CONTENT) {
    const m = s.match(rule.pattern);
    if (m) violations.push({ field: fieldName, rule: rule.id, matched: m[0], why: rule.why });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * The output is handed to a customer, so amounts must be exact to the cent.
 * Money is stored as Float here (see tests/unit/pricing-money.test.js — 38
 * Float columns, no rounding in the pricing path), so a raw value can carry a
 * sub-cent tail like 1536.87288. Rounding at this boundary is what keeps the
 * letter's line items summing to its total in the reader's arithmetic; it does
 * NOT fix the underlying storage problem.
 */
function formatMoney(n, currency = 'USD') {
  if (n == null || Number.isNaN(Number(n))) return null;
  const cents = Math.round(Number(n) * 100);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${sign}${symbol}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

function formatDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Dates as they appear in the letter itself. ISO is right for the summary and
 * the audit record; a document a homeowner reads should say "May 4, 2026".
 * UTC parts deliberately, so the rendered date matches the stored one rather
 * than shifting by a day depending on where the server happens to be.
 */
function formatLongDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}

/** Body text width. Fits the renderer's Courier 10pt page with margin to spare. */
const WRAP_WIDTH = 78;

/**
 * Wrap to WRAP_WIDTH, preserving blank lines and hanging-indenting list items
 * so a wrapped bullet still reads as one item. Without this, long sentences
 * ran off the right edge of the generated PDF — the renderer does no layout of
 * its own, so line breaks have to be decided here.
 */
function wrapLines(lines, width = WRAP_WIDTH) {
  const out = [];
  for (const line of lines) {
    if (line.length <= width) { out.push(line); continue; }
    const bullet = /^(\s*-\s+)/.exec(line);
    const indent = bullet ? ' '.repeat(bullet[1].length) : '';
    let current = '';
    for (const word of line.split(' ')) {
      // A single token longer than the page (a pasted URL, a run-on string)
      // has no space to break at, so it must be broken by force. Without this
      // the loop happily emits one 300-character line and it runs straight off
      // the right edge of the PDF — the renderer does no layout of its own.
      let rest = word;
      while (rest.length > width) {
        if (current !== '') { out.push(current); current = ''; }
        out.push(rest.slice(0, width));
        rest = indent + rest.slice(width);
      }
      if (current === '') { current = rest; continue; }
      if (`${current} ${rest}`.length > width) { out.push(current); current = indent + rest; }
      else current += ` ${rest}`;
    }
    if (current !== '') out.push(current);
  }
  return out;
}

/** Whole days between two dates, floor. Returns null if either is missing. */
function daysBetween(from, to) {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor((b - a) / 86400000);
}

/**
 * Validate the attestation payload. Throws rather than returning a flag: a
 * letter generated without a complete attestation is the thing this module
 * exists to prevent, so it must not be possible to ignore the return value.
 */
function assertAttested(attestation, intendedActions) {
  const given = (attestation && attestation.confirmed) || {};
  const missing = REQUIRED_ATTESTATIONS.filter(a => given[a.id] !== true).map(a => a.id);
  if (missing.length) {
    throw new DemandLetterError(
      'Every attestation must be confirmed before a demand letter can be generated.',
      'attestation_incomplete',
      { missing, required: REQUIRED_ATTESTATIONS },
    );
  }
  // Each threatened action carries its own affirmation. Confirming "I intend
  // to take every action described" in the abstract is not the same as
  // confirming a specific right exists, and it is the specific one that
  // answers "threat of action that cannot legally be taken".
  const unaffirmed = (intendedActions || []).filter(k => given[`action:${k}`] !== true);
  if (unaffirmed.length) {
    throw new DemandLetterError(
      'Each action named in the letter must be separately affirmed.',
      'action_not_affirmed',
      {
        unaffirmed,
        affirmations: unaffirmed.map(k => ({ action: k, text: INTENDED_ACTIONS[k].requiresAffirmation })),
      },
    );
  }
}

function assertKnownActions(intendedActions) {
  const unknown = (intendedActions || []).filter(k => !INTENDED_ACTIONS[k]);
  if (unknown.length) {
    throw new DemandLetterError(
      'Unrecognized action. The consequences a letter may mention are a fixed list.',
      'unknown_action',
      { unknown, allowed: Object.keys(INTENDED_ACTIONS) },
    );
  }
}

/**
 * The closing block. Fixed text, built here rather than assembled inline so
 * there is exactly one copy of it and a test can pin it verbatim.
 *
 * The second sentence is doing real work: it rebuts both the 1692a(6)
 * false-name inference (a creditor using a name that implies a third party is
 * collecting) and the 1692j "false belief" element, by stating plainly that no
 * third party is involved.
 */
function buildFooter(senderName, isConsumer) {
  // Wrapped rather than hand-broken: the sender's legal name is interpolated
  // twice, so the line lengths depend on it and fixed breaks would run off the
  // page for any company with a long name.
  const f = [
    '-'.repeat(70),
    ...wrapLines([
      `${senderName} is not an attorney and this letter does not constitute legal advice. `
      + `${senderName} is the creditor on this account and is communicating directly; `
      + 'no third party is involved in this communication.',
    ]),
  ];
  if (isConsumer) {
    // Not federally required of a first-party creditor, and arguably implies
    // debt-collector status. Included for consumer recipients anyway: Cal.
    // Civ. Code 1788.17 incorporates 15 U.S.C. 1692b-1692j into the Rosenthal
    // Act for first-party creditors, and whether that pulls in the 1692g
    // validation notice is genuinely unsettled. The cost of including it is a
    // sentence; the cost of omitting it, if a court reads it as required, is
    // statutory damages.
    f.push('');
    f.push(...wrapLines([
      'This is an attempt to collect a debt. Any information obtained will be used for that purpose.',
    ]));
  }
  return f;
}

/**
 * Last line of defence, run on the assembled letter BODY rather than on its
 * inputs.
 *
 * Screening inputs is not sufficient: composed sentences can contain a
 * prohibited phrase that no single input did, and a future edit to the
 * sentence templates in this file would bypass input screening entirely.
 * Checking the output catches both. Fails closed — a letter that trips this is
 * not produced at all, rather than produced with a warning.
 *
 * The footer is deliberately NOT screened by these rules, and that is not a
 * loophole. PROHIBITED_CONTENT catches assertions ("our attorney will call
 * you"); the footer makes the opposite claim ("is not an attorney"), and a
 * regex cannot tell an assertion from its negation without becoming exactly
 * the kind of clever that fails silently later. The footer is instead fixed
 * text with a single definition (buildFooter) that a test pins verbatim — so
 * changing it fails a test loudly, which is the protection that mattered.
 * Vendor branding is checked across the whole letter, footer included, since
 * that rule is a simple substring with no such ambiguity.
 */
function assertOutputClean(lines) {
  const body = Array.isArray(lines) ? lines.join('\n') : String(lines);
  const violations = screenText(body, 'letter').violations;
  if (violations.length) {
    throw new DemandLetterError(
      'The composed letter contains content that must not be sent.',
      'unsafe_letter_content',
      { violations },
    );
  }
}

/** Checked across the entire letter, footer included. See 1692j above. */
function assertNoVendorBranding(lines) {
  const all = Array.isArray(lines) ? lines.join('\n') : String(lines);
  const m = all.match(VENDOR_MARKERS);
  if (!m) return;
  throw new DemandLetterError(
    'The composed letter contains content that must not be sent.',
    'unsafe_letter_content',
    {
      violations: [{
        field: 'letter', rule: 'vendor_branding', matched: m[0],
        why: 'The letter must come from the contractor alone. Any hint that a third party is involved in collecting this debt is independently unlawful (15 U.S.C. 1692j) and it is the software vendor, not the contractor, who is liable for it.',
      }],
    },
  );
}

/**
 * Build the letter. Shared by preview() and compose() so that the letter a
 * contractor reads and the letter that gets sent are produced by the same code
 * from the same inputs — byte-identical, not merely similar. That is the whole
 * point: the attestation says "I have read this letter in full and approve it
 * as my own communication", which means nothing if the reviewed draft and the
 * sent document can differ.
 *
 * Every fact comes from `facts`; nothing is inferred and nothing is inflated.
 * Where a fact is missing the sentence is omitted rather than hedged, because
 * a letter that says "on or about [date]" about work someone actually did is
 * weaker evidence than one that simply doesn't mention the date.
 *
 * Returns { lines, warnings, summary }. `warnings` are for the contractor's
 * review screen — things that weaken the letter but are not unlawful.
 */
function _composeBody(facts) {
  const {
    org = {},              // OrganizationRecord: legal_name, address, phone, website
    signer = {},           // { name, title } — a named human, not "the office"
    customer = {},         // Customer: name, companyName, address
    recipientType = 'homeowner',
    project = {},          // ProjectRecord: name, project_number, address
    changeOrders = [],     // [{ title, approvedOn, completedOn, amount }]
    invoice = {},          // { number, date, amount, dueDate }
    amountDue,
    evidenceCounts = {},   // { photos, documents, findings }
    intendedActions = [],
    responseDueDate,
    additionalContext,     // contractor free text — screened
    attestation,
    now = new Date(),
    currency = 'USD',
  } = facts || {};

  if (!RECIPIENT_TYPES[recipientType]) {
    throw new DemandLetterError('Unknown recipient type.', 'unknown_recipient_type',
      { allowed: Object.keys(RECIPIENT_TYPES) });
  }
  assertKnownActions(intendedActions);

  const ctx = screenText(additionalContext, 'additionalContext');
  if (!ctx.ok) {
    throw new DemandLetterError(
      'Your added notes contain content that cannot be sent in this letter.',
      'unsafe_user_content', { violations: ctx.violations },
    );
  }

  const senderName = org.legal_name || org.name;
  if (!senderName) {
    throw new DemandLetterError(
      'Your organization\'s legal name is required — the letter must clearly identify you as the sender.',
      'missing_sender_identity', { field: 'org.legal_name' },
    );
  }
  if (!signer.name) {
    throw new DemandLetterError(
      'A named person must sign this letter.',
      'missing_signer', { field: 'signer.name' },
    );
  }
  if (amountDue == null || !(Number(amountDue) > 0)) {
    throw new DemandLetterError(
      'A positive amount due is required.',
      'missing_amount', { field: 'amountDue' },
    );
  }

  const warnings = [];
  const money = (n) => formatMoney(n, currency);
  const L = [];
  const recipientName = customer.companyName || customer.name || null;
  if (!recipientName) warnings.push('No recipient name — the letter will be addressed generically.');

  // ── Letterhead: the contractor's, and only the contractor's ──────────────
  L.push(senderName);
  if (org.address) L.push(org.address);
  const contact = [org.phone, org.website].filter(Boolean).join('  |  ');
  if (contact) L.push(contact);
  L.push('');
  L.push(formatLongDate(now));
  L.push('');

  // ── Addressee ────────────────────────────────────────────────────────────
  if (recipientName) L.push(recipientName);
  if (customer.address) L.push(customer.address);
  L.push('');

  const projectLabel = [project.name, project.project_number && `(${project.project_number})`]
    .filter(Boolean).join(' ');
  L.push(`RE: Past-due balance${projectLabel ? ` — ${projectLabel}` : ''}`);
  if (project.address) L.push(`    ${project.address}`);
  L.push('');
  L.push(recipientName ? `Dear ${recipientName},` : 'To whom it may concern,');
  L.push('');

  // ── Opening: what is owed, stated once, plainly ──────────────────────────
  L.push(`This letter concerns an unpaid balance of ${money(amountDue)} for work performed${projectLabel ? ` on ${project.name}` : ''}.`);
  L.push('');

  // ── The facts, each one traceable to a record in the system ─────────────
  const facts_ = [];
  for (const co of changeOrders) {
    if (!co || !co.title) continue;
    const bits = [];
    const approved = formatLongDate(co.approvedOn);
    const completed = formatLongDate(co.completedOn);
    if (approved) bits.push(`approved on ${approved}`);
    else warnings.push(`"${co.title}" has no recorded approval date — the strongest fact in a demand letter is a documented approval, so consider attaching the approval separately.`);
    if (completed) bits.push(`completed on ${completed}`);
    if (co.amount != null) bits.push(`valued at ${money(co.amount)}`);
    // "was approved on X, completed on Y, and valued at $Z" — one leading verb
    // for the whole clause, so the sentence reads as prose rather than as
    // three fragments stapled together.
    const joined = bits.length > 1
      ? `${bits.slice(0, -1).join(', ')}, and ${bits[bits.length - 1]}`
      : bits[0];
    facts_.push(bits.length ? `- "${co.title}" was ${joined}.` : `- "${co.title}".`);
  }
  if (facts_.length) {
    L.push('The balance covers the following approved change order work:');
    L.push('');
    L.push(...facts_);
    L.push('');
  }

  if (invoice.number || invoice.date) {
    const parts = [];
    if (invoice.number) parts.push(`Invoice ${invoice.number}`);
    if (invoice.date) parts.push(`was issued on ${formatLongDate(invoice.date)}`);
    if (invoice.amount != null) parts.push(`in the amount of ${money(invoice.amount)}`);
    let sentence = parts.join(' ') + '.';
    const age = daysBetween(invoice.date, now);
    // Stated as elapsed time since the invoice, which is arithmetic on a date
    // the contractor supplied. Deliberately NOT "you are N days late", which
    // would assert a payment term we have not verified, nor anything about a
    // statutory deadline, which would be legal advice.
    if (age != null && age > 0) sentence += ` That was ${age} day${age === 1 ? '' : 's'} ago.`;
    L.push(sentence);
    L.push('');
  } else {
    warnings.push('No invoice number or date — a demand is materially stronger when it references a specific invoice.');
  }

  // ── Evidence, described rather than characterised ─────────────────────────
  const ev = [];
  if (evidenceCounts.photos)    ev.push(`${evidenceCounts.photos} photograph${evidenceCounts.photos === 1 ? '' : 's'} with capture timestamps`);
  if (evidenceCounts.documents) ev.push(`${evidenceCounts.documents} supporting document${evidenceCounts.documents === 1 ? '' : 's'}`);
  if (ev.length) {
    L.push(`Supporting records are attached to this packet, including ${ev.join(' and ')}.`);
    L.push('');
  } else {
    warnings.push('No photo or document evidence is attached. The evidence is what makes this letter persuasive; consider attaching it before sending.');
  }

  if (additionalContext) {
    // Split on the contractor's own line breaks rather than pushing the whole
    // block as one array element. Each element becomes one rendered line, and
    // an embedded \n survives wrapping only to hit pdfStr, which maps control
    // characters to '?' — so a perfectly ordinary multi-paragraph note came
    // out as literal question marks in the mailed PDF.
    for (const para of String(additionalContext).trim().split(/\r?\n/)) {
      L.push(para.trim());
    }
    L.push('');
  }

  // ── The ask ──────────────────────────────────────────────────────────────
  const by = formatLongDate(responseDueDate);
  L.push(by
    ? `We are requesting payment of ${money(amountDue)} by ${by}.`
    : `We are requesting payment of ${money(amountDue)}.`);

  if (intendedActions.length) {
    const sentences = intendedActions.map(k => INTENDED_ACTIONS[k].sentence);
    const joined = sentences.length === 1
      ? sentences[0]
      : `${sentences.slice(0, -1).join(', ')}, and ${sentences[sentences.length - 1]}`;
    L.push(`If payment is not received${by ? ` by ${by}` : ''}, ${joined}.`);
  }
  L.push('');
  L.push('If any part of this is inaccurate, or if you believe payment has already been made, please contact us so we can resolve it directly.');
  L.push('');

  // ── Signature: a named human ─────────────────────────────────────────────
  L.push('Sincerely,');
  L.push('');
  L.push('');
  L.push(signer.name);
  if (signer.title) L.push(signer.title);
  L.push(senderName);
  L.push('');
  L.push('');

  // Screened before the footer is attached — see assertOutputClean's comment
  // on why the fixed footer is pinned by a test instead of by these rules.
  assertOutputClean(L);

  const footer = buildFooter(senderName, RECIPIENT_TYPES[recipientType].consumer);
  // Wrapped last, so screening runs on whole sentences. Wrapping first would
  // let a prohibited phrase split across two lines and slip the regexes.
  const lines = [...wrapLines(L), ...footer];
  assertNoVendorBranding(lines);

  return {
    lines,
    warnings,
    summary: {
      recipientType,
      amountDue: Number(amountDue),
      amountDueFormatted: money(amountDue),
      responseDueDate: formatDate(responseDueDate),
      intendedActions: [...intendedActions],
      changeOrderCount: changeOrders.length,
      evidenceCounts,
      // Recorded so the sent letter can be tied back to the exact attestation
      // that authorised it. Without this the attestation is a checkbox; with
      // it, it is a record.
      attestedAt: attestation && attestation.attestedAt ? formatDate(attestation.attestedAt) : null,
    },
  };
}

/**
 * The letter as it will be sent, WITHOUT requiring an attestation yet — this
 * is what the contractor reads before attesting to it.
 *
 * Also returns the exact list of confirmations they will have to make, so the
 * review screen is generated from the same source of truth that later enforces
 * it, rather than from a hand-maintained copy that can drift out of step.
 */
function preview(facts) {
  const out = _composeBody(facts);
  const actions = (facts && facts.intendedActions) || [];
  return {
    ...out,
    draft: true,
    requiredAttestations: [
      ...REQUIRED_ATTESTATIONS,
      ...actions.map(k => ({ id: `action:${k}`, text: INTENDED_ACTIONS[k].requiresAffirmation })),
    ],
  };
}

/**
 * The letter, gated on a complete attestation. Same body as preview() — the
 * gate is the only difference, and it lives here rather than in the route so
 * that no future caller can reach a composed letter without passing it.
 */
function compose(facts) {
  const { attestation, intendedActions = [] } = facts || {};
  assertKnownActions(intendedActions);
  assertAttested(attestation, intendedActions);
  return { ..._composeBody(facts), draft: false };
}

module.exports = {
  RECIPIENT_TYPES,
  INTENDED_ACTIONS,
  PROHIBITED_CONTENT,
  REQUIRED_ATTESTATIONS,
  DemandLetterError,
  screenText,
  assertAttested,
  assertKnownActions,
  assertOutputClean,
  assertNoVendorBranding,
  buildFooter,
  formatMoney,
  daysBetween,
  preview,
  compose,
};
