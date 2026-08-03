/**
 * Payment demand letter composition and its safety rules.
 *
 * The interesting tests here are the ones that assert the module REFUSES.
 * A demand letter is the one artefact this product generates that goes
 * directly to a third party and asserts money is owed, so the failure modes
 * are legal rather than technical: unauthorized practice of law, 15 U.S.C.
 * 1692e/1692j, and the state acts that reach first-party creditors.
 *
 * Each prohibition below traces to a specific rule in lib/demand-letter.js;
 * where a test exists to prevent one concrete bad sentence, it says which.
 */
const dl = require('../../lib/demand-letter');

// A complete, valid input. Individual tests break one thing at a time so the
// assertion is about that thing and not about incidental missing fields.
const ATTESTED = {
  attestedAt: new Date('2026-08-01T12:00:00Z'),
  confirmed: {
    has_written_authorization: true,
    work_completed: true,
    amount_accurate: true,
    intends_actions: true,
    reviewed_and_adopts: true,
  },
};

const BASE = {
  org: { legal_name: 'Ridgeline Roofing LLC', address: '400 Mill St, Akron OH 44311', phone: '(330) 555-0142' },
  signer: { name: 'Dana Okafor', title: 'Owner' },
  customer: { name: 'Priya Raman', address: '18 Elm Ct, Akron OH 44313' },
  recipientType: 'homeowner',
  project: { name: 'Elm Ct re-roof', project_number: 'P-2291' },
  changeOrders: [
    { title: 'Deck replacement — north slope', approvedOn: '2026-05-04', completedOn: '2026-05-11', amount: 4820.5 },
  ],
  invoice: { number: 'INV-1043', date: '2026-05-15', amount: 4820.5 },
  amountDue: 4820.5,
  evidenceCounts: { photos: 24, documents: 3 },
  intendedActions: [],
  responseDueDate: '2026-08-15',
  attestation: ATTESTED,
  now: new Date('2026-08-01T12:00:00Z'),
};

const text = (r) => r.lines.join('\n');
// Prose assertions run against the flattened letter: the body is wrapped to a
// page width, so a sentence can legitimately span two lines and asserting on
// `lines` would make every test hostage to where the wrap happens to fall.
const flat = (r) => r.lines.join(' ').replace(/\s+/g, ' ');

describe('composing a letter from facts', () => {
  test('states the amount, the approval, the completion and the invoice', () => {
    const t = flat(dl.compose(BASE));
    expect(t).toContain('$4,820.50');
    expect(t).toContain(
      'was approved on May 4, 2026, completed on May 11, 2026, and valued at $4,820.50.');
    expect(t).toContain('Invoice INV-1043');
    expect(t).toContain('We are requesting payment of $4,820.50 by August 15, 2026.');
  });

  test('the contractor is the sender and the signer is a named human', () => {
    // 15 U.S.C. 1692a(6) false-name exception: a creditor using a name that
    // suggests a third party is collecting becomes a full FDCPA debt
    // collector. The letterhead and the signature are what prevent that.
    const t = text(dl.compose(BASE));
    expect(t.startsWith('Ridgeline Roofing LLC')).toBe(true);
    expect(t).toContain('Dana Okafor');
    expect(t).toContain('Owner');
  });

  test('elapsed time is stated as arithmetic, not as a legal conclusion', () => {
    const t = flat(dl.compose(BASE));
    // 78 days from 2026-05-15 to 2026-08-01.
    expect(t).toContain('That was 78 days ago.');
    // Not "you are 78 days late" — that asserts a payment term we never
    // verified — and nothing about any statutory deadline.
    expect(t).not.toMatch(/days\s+late|past\s+due\s+by|deadline/i);
  });

  test('omits facts it does not have rather than hedging them', () => {
    const out = dl.compose({
      ...BASE,
      changeOrders: [{ title: 'Deck replacement — north slope', amount: 4820.5 }],
      invoice: {},
    });
    const t = flat(out);
    expect(t).not.toMatch(/on or about|approximately|\[date\]|undefined|null/i);
    expect(t).toContain('"Deck replacement — north slope" was valued at $4,820.50.');
  });

  test('warns about weaknesses without refusing to compose', () => {
    // These make a letter less persuasive. They are not unlawful, so they are
    // review-screen warnings rather than errors — refusing here would just
    // teach people to route around the feature.
    const out = dl.compose({
      ...BASE,
      changeOrders: [{ title: 'Deck replacement', amount: 4820.5 }],
      invoice: {},
      evidenceCounts: {},
    });
    const joined = out.warnings.join(' ');
    expect(joined).toMatch(/no recorded approval date/i);
    expect(joined).toMatch(/invoice/i);
    expect(joined).toMatch(/evidence/i);
    expect(out.lines.length).toBeGreaterThan(10);
  });

  test('money is rounded to the cent at the letter boundary', () => {
    // Amounts persist as Float (see pricing-money.test.js), so a real value
    // can arrive carrying a sub-cent tail. A customer-facing document must
    // not show $1536.8728800000001, and its numbers must add up on paper.
    const out = dl.compose({ ...BASE, amountDue: 1536.87288, invoice: { number: 'INV-1', date: '2026-05-15', amount: 1536.87288 } });
    expect(flat(out)).toContain('$1,536.87');
    expect(flat(out)).not.toMatch(/1536\.8728/);
    expect(dl.formatMoney(0)).toBe('$0.00');
    expect(dl.formatMoney(-250)).toBe('-$250.00');
  });

  test('rounding to the cent does not make the float problem go away', () => {
    // Math.round(n * 100) is the right thing to do here and still cannot be
    // exact, because the double nearest 1234567.005 is below the true value:
    // 1234567.005 * 100 === 123456700.49999999, so this rounds DOWN.
    // Asserted rather than hidden, matching pricing-money.test.js — formatting
    // is the last place the drift is visible, not the place it is fixed. The
    // fix is integer cents in the database (TODO.md), and this is one more
    // reason for it: the number here is one a customer reads.
    expect(dl.formatMoney(1234567.005)).toBe('$1,234,567.00');
    expect(1234567.005 * 100).toBe(123456700.49999999);
  });
});

describe('the letter never gives legal advice', () => {
  test('no statute is ever cited, even if the contractor supplies one', () => {
    // Unauthorized practice of law: selecting which law applies to a specific
    // set of facts is the line (N.C. State Bar v. Lienguard).
    expect(() => dl.compose({
      ...BASE,
      additionalContext: 'Payment is required under Ohio Rev. Code section 4113.61 within 30 days.',
    })).toThrow(/cannot be sent/i);

    try {
      dl.compose({ ...BASE, additionalContext: 'You owe this pursuant to statute 1692.' });
    } catch (e) {
      expect(e.code).toBe('unsafe_user_content');
      expect(e.details.violations.map(v => v.rule)).toContain('statutory_citation');
    }
  });

  test('no lien or payment deadline is ever computed', () => {
    // The deliberate omission. Computing "your lien deadline is October 14"
    // is applying law to facts, and it is the single most enjoinable thing
    // this product could do. Nothing in the module produces one.
    const t = flat(dl.compose({ ...BASE, intendedActions: ['lien_or_bond_claim'],
      attestation: { ...ATTESTED, confirmed: { ...ATTESTED.confirmed, 'action:lien_or_bond_claim': true } } }));
    expect(t).not.toMatch(/lien\s+(deadline|must\s+be\s+filed|expires)/i);
    expect(t).not.toMatch(/you\s+have\s+\d+\s+days\s+to/i);
    // What it does say is an intention the contractor affirmed, hedged to
    // "may include" because we do not know whether the right exists.
    expect(t).toContain('which may include a mechanics lien or bond claim');
  });

  test('the footer disclaims legal advice and third-party involvement', () => {
    const t = flat(dl.compose(BASE));
    expect(t).toContain('is not an attorney and this letter does not constitute legal advice');
    // Rebuts both 1692a(6) false-name and the 1692j "false belief" element.
    expect(t).toContain('no third party is involved in this communication');
  });

  test('the footer text is pinned verbatim', () => {
    // This test IS the protection on the footer. PROHIBITED_CONTENT catches
    // assertions ("our attorney will call you"); the footer makes the opposite
    // claim ("is not an attorney"), and a regex cannot separate an assertion
    // from its negation without becoming the kind of clever that fails
    // silently. So the footer is excluded from screening and pinned here
    // instead: changing a word of it fails loudly, which is what mattered.
    // If you are updating this, the change needs legal review, not a re-record.
    // Asserted on the joined sentences rather than the line array: the wording
    // is what carries legal weight, the line breaks are just layout and depend
    // on how long the sender's name is.
    const plain = dl.buildFooter('Acme LLC', false);
    expect(plain[0]).toBe('-'.repeat(70));
    expect(plain.slice(1).join(' ')).toBe(
      'Acme LLC is not an attorney and this letter does not constitute legal advice. '
      + 'Acme LLC is the creditor on this account and is communicating directly; '
      + 'no third party is involved in this communication.');

    const consumer = dl.buildFooter('Acme LLC', true);
    expect(consumer.slice(plain.length + 1).join(' ')).toBe(
      'This is an attempt to collect a debt. Any information obtained will be used for that purpose.');
  });

  test('no line runs past the page width', () => {
    // The renderer does no layout of its own, so anything longer than this
    // runs off the right edge of the generated PDF.
    const longName = 'Ridgeline Roofing & Exterior Restoration of Northeast Ohio LLC';
    for (const line of dl.compose({ ...BASE, org: { ...BASE.org, legal_name: longName } }).lines) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
  });
});

describe('the vendor never appears on the letter', () => {
  test('output containing the vendor name is refused, not warned about', () => {
    // 15 U.S.C. 1692j reaches whoever DESIGNS and FURNISHES a form knowing it
    // will create the false belief that someone other than the creditor is
    // participating — direct liability on us, not on the contractor.
    expect(() => dl.assertNoVendorBranding(['Generated automatically by ScopeCash AI.']))
      .toThrow(/must not be sent/i);
    try {
      dl.assertNoVendorBranding(['Powered by ScopeCash']);
    } catch (e) {
      expect(e.code).toBe('unsafe_letter_content');
      expect(e.details.violations[0].rule).toBe('vendor_branding');
    }
  });

  test('a clean composed letter carries no vendor marker anywhere', () => {
    // The generic packet disclaimer block in lib/tools/pdfpacketrenderer.js
    // says "generated automatically by ScopeCash AI". On this document that
    // sentence is the violation, so it must never be rendered into it.
    expect(text(dl.compose(BASE))).not.toMatch(/scope\s?cash/i);
  });

  test('the output check runs on the assembled letter, not just its inputs', () => {
    // Screening inputs alone would miss a prohibited phrase produced by
    // composition itself, and would be bypassed entirely by a future edit to
    // the templates in the module. Checking the output catches both.
    expect(() => dl.assertOutputClean(['We have referred this to our legal department.']))
      .toThrow(/must not be sent/i);
  });
});

describe('prohibited content', () => {
  const cases = [
    ['attorney_implication',  'Our legal department will be in touch.'],
    ['attorney_implication',  'FINAL LEGAL NOTICE'],
    ['government_implication', 'Official Notice — Docket No. 44-11'],
    ['criminal_accusation',   'This is theft and we will press charges.'],
    ['criminal_accusation',   'You have misapplied trust funds on this project.'],
    ['credit_reporting',      'This will be reported to Experian and hurt your credit score.'],
    ['coercive_third_party',  'We will file a complaint with the state licensing board.'],
    ['coercive_third_party',  'We will be leaving a Google review about this.'],
    ['statutory_citation',    'You are liable under 15 U.S.C. 1692.'],
  ];

  test.each(cases)('%s — rejects: %s', (rule, sample) => {
    const r = dl.screenText(sample);
    expect(r.ok).toBe(false);
    expect(r.violations.map(v => v.rule)).toContain(rule);
  });

  test('the misapplied-trust-funds sentence is caught specifically', () => {
    // Worth its own test: it is common in real contractor correspondence and
    // it violates three things at once — 1692e(7) false implication of crime,
    // criminal extortion (Cal. Penal Code 519), and UPL by applying a
    // criminal statute to the recipient's facts.
    for (const s of [
      'You are diverting construction trust funds.',
      'This is a misapplication of trust funds.',
    ]) {
      expect(dl.screenText(s).ok).toBe(false);
    }
  });

  test('every violation is reported, not just the first', () => {
    // Someone fixing a paragraph should be told everything wrong with it
    // rather than discovering the problems one submit at a time.
    const r = dl.screenText('Our attorney will report this theft to your licensing board.');
    const rules = r.violations.map(v => v.rule);
    expect(rules).toEqual(expect.arrayContaining(
      ['attorney_implication', 'criminal_accusation', 'coercive_third_party']));
  });

  test('each rejection explains the actual risk', () => {
    // A rejection the user does not understand gets worked around: they
    // retype it another way and the screening has achieved nothing.
    for (const rule of dl.PROHIBITED_CONTENT) {
      expect(rule.why.length).toBeGreaterThan(40);
    }
  });

  test('ordinary business language is not caught', () => {
    // False positives here are expensive — they make the feature unusable and
    // push people back to writing letters by hand with no screening at all.
    for (const s of [
      'The work was completed on May 11 and inspected the same week.',
      'Please contact our office if you believe payment has already been made.',
      'We installed 42 squares of architectural shingle and replaced the north deck.',
      'Our records show a balance of $4,820.50 outstanding on invoice INV-1043.',
      'We would rather resolve this directly than escalate it.',
    ]) {
      expect(dl.screenText(s)).toEqual({ ok: true, violations: [] });
    }
  });
});

describe('threatened consequences are a closed set', () => {
  test('an action outside the whitelist is refused', () => {
    // Free text here is how a letter becomes extortion; no amount of
    // screening catches every phrasing, so the set is closed.
    expect(() => dl.compose({ ...BASE, intendedActions: ['report_to_licensing_board'] }))
      .toThrow(/fixed list/i);
    try {
      dl.compose({ ...BASE, intendedActions: ['call_your_lender'] });
    } catch (e) {
      expect(e.code).toBe('unknown_action');
      expect(e.details.allowed).toEqual(
        expect.arrayContaining(['suspend_work', 'civil_suit', 'lien_or_bond_claim', 'contract_remedies']));
    }
  });

  test('every allowed action has a nexus to this debt', () => {
    // Flatley v. Mauro: a threatened consequence must be one the sender may
    // lawfully take AND must connect to the claim being asserted. Suing over
    // the unpaid invoice qualifies; reporting someone to a licensing board
    // does not, which is why no such entry exists.
    for (const [, a] of Object.entries(dl.INTENDED_ACTIONS)) {
      expect(a.sentence).toMatch(/suspend further work|suit for breach|remedies/i);
      expect(a.requiresAffirmation.length).toBeGreaterThan(20);
    }
  });

  test('a named action must be separately affirmed', () => {
    // "I intend to take every action described" in the abstract is not the
    // same as confirming a specific right exists. 1692e(5) makes threatening
    // action that cannot be taken the violation, so the specific one matters.
    expect(() => dl.compose({ ...BASE, intendedActions: ['civil_suit'] }))
      .toThrow(/separately affirmed/i);

    const ok = dl.compose({
      ...BASE,
      intendedActions: ['civil_suit'],
      attestation: { ...ATTESTED, confirmed: { ...ATTESTED.confirmed, 'action:civil_suit': true } },
    });
    expect(flat(ok)).toContain('we intend to file suit for breach of contract');
  });

  test('multiple actions read as a sentence', () => {
    const out = dl.compose({
      ...BASE,
      intendedActions: ['suspend_work', 'civil_suit'],
      attestation: { ...ATTESTED, confirmed: {
        ...ATTESTED.confirmed, 'action:suspend_work': true, 'action:civil_suit': true } },
    });
    expect(flat(out)).toContain(
      'we intend to suspend further work on this project, and we intend to file suit for breach of contract.');
  });

  test('no action at all is valid — the letter simply asks for payment', () => {
    const t = flat(dl.compose(BASE));
    expect(t).toContain('We are requesting payment');
    expect(t).not.toMatch(/if payment is not received/i);
  });
});

describe('attestation is required, not advisory', () => {
  test('composing without a complete attestation throws', () => {
    // The attestations are what make the contractor the author of their own
    // communication — the UPL answer and the 1692e(5) answer both. A return
    // flag could be ignored; this cannot be.
    expect(() => dl.compose({ ...BASE, attestation: undefined })).toThrow(/attestation/i);
    expect(() => dl.compose({ ...BASE, attestation: { confirmed: {} } })).toThrow(/attestation/i);
  });

  test('a partially completed attestation names exactly what is missing', () => {
    try {
      dl.compose({ ...BASE, attestation: { confirmed: { ...ATTESTED.confirmed, work_completed: false } } });
      throw new Error('should not reach here');
    } catch (e) {
      expect(e.code).toBe('attestation_incomplete');
      expect(e.details.missing).toEqual(['work_completed']);
    }
  });

  test('truthy-but-not-true does not count as confirmation', () => {
    // A checkbox serialised as "on" or 1 must not silently satisfy a legal
    // attestation; the client has to send an actual boolean.
    for (const v of ['true', 1, 'on', {}]) {
      expect(() => dl.compose({
        ...BASE, attestation: { confirmed: { ...ATTESTED.confirmed, amount_accurate: v } },
      })).toThrow(/attestation/i);
    }
  });

  test('the attestation is recorded on the result', () => {
    // Without this the attestation is a checkbox; with it, it is a record
    // tying the sent letter to the confirmation that authorised it.
    expect(dl.compose(BASE).summary.attestedAt).toBe('2026-08-01');
  });
});

describe('recipient type', () => {
  test('consumer recipients get the debt-collection notice', () => {
    // Not federally required of a first-party creditor. Included because Cal.
    // Civ. Code 1788.17 incorporates 1692b-1692j into the Rosenthal Act for
    // first-party creditors and whether that reaches the 1692g notice is
    // genuinely unsettled — a sentence to include, statutory damages to omit.
    expect(flat(dl.compose(BASE))).toContain('This is an attempt to collect a debt.');
  });

  test('commercial recipients do not', () => {
    // A commercial GC balance is not "debt" under 1692a(5) at all, so the
    // notice would be inaccurate rather than merely unnecessary.
    const t = flat(dl.compose({ ...BASE, recipientType: 'commercial',
      customer: { companyName: 'Halstead Construction Inc.' } }));
    expect(t).not.toContain('attempt to collect a debt');
    expect(t).toContain('Halstead Construction Inc.');
  });

  test('an unknown recipient type is refused', () => {
    // The type selects the legal ruleset, so guessing is not acceptable.
    expect(() => dl.compose({ ...BASE, recipientType: 'tenant' })).toThrow(/recipient type/i);
  });
});

describe('required identity', () => {
  test('a letter with no identified sender is refused', () => {
    expect(() => dl.compose({ ...BASE, org: {} })).toThrow(/legal name/i);
  });

  test('a letter with no named signer is refused', () => {
    // "The Office" or a bare company name reads as an anonymous collection
    // notice, which is the impression 1692a(6) is about.
    expect(() => dl.compose({ ...BASE, signer: {} })).toThrow(/named person/i);
  });

  test('a non-positive amount is refused', () => {
    for (const amountDue of [0, -100, null, undefined, 'abc']) {
      expect(() => dl.compose({ ...BASE, amountDue })).toThrow(/amount/i);
    }
  });
});
