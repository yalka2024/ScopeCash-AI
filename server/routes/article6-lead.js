/**
 * Public Article 6 lead-capture endpoint (Tier 20 — lead magnet).
 *
 *   POST /api/article6/lead
 *     Body: { email, organisation?, useCaseDescription?, marketingConsent?, verdict, answers }
 *     Stores a `article6.lead` GrowthEvent and emails the verdict to the
 *     supplied address. Public, rate-limited, no auth.
 *
 * The classification itself runs through the existing public endpoint
 * `POST /api/eu-ai-act/classify` — this route only persists the lead and
 * dispatches the email so the wizard can convert visitors into trial users.
 */
const express = require('express');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const limiters = require('../lib/ratelimit');
const events = require('../lib/growth-events');
const email = require('../lib/email');
const { encrypt, searchHash } = require('../lib/encryption');

const router = express.Router();

// Verdict shape mirrors lib/eu-ai-act-classifier.js#classify result.
// Verdict is produced by the public classifier; we accept its shape loosely
// (obligations / citations may be strings or objects, reasoning may be string
// or array) and only enforce a hard size cap to prevent abuse.
const VerdictSchema = z.object({
  risk:        z.enum(['prohibited', 'high', 'limited', 'minimal']).optional(),
  score:       z.number().min(0).max(100).optional(),
  reasoning:   z.union([z.string().max(4000), z.array(z.any()).max(40)]).optional(),
  obligations: z.array(z.any()).max(80).optional(),
  deadline:    z.string().max(200).optional(),
  citations:   z.array(z.any()).max(80).optional(),
}).passthrough();

const LeadSchema = z.object({
  email:               z.string().email().max(254),
  organisation:        z.string().max(200).optional(),
  useCaseDescription:  z.string().max(5000).optional(),
  marketingConsent:    z.boolean().optional(),
  verdict:             VerdictSchema,
  answers:             z.record(z.any()).optional(),
});

router.post('/lead', limiters.expensive, validate(LeadSchema), asyncHandler(async (req, res) => {
  const { email: leadEmail, organisation, useCaseDescription, marketingConsent, verdict, answers } = req.body;

  // Persist lead as a growth event. PII (email, organisation, free-text use
  // case) is encrypted at rest with AES-256-GCM via lib/encryption (DATA-005).
  // A deterministic searchHash on the email enables dedupe / lookup without
  // exposing the plaintext.
  events.track({
    name: 'article6.lead',
    source: 'client',
    properties: {
      emailEnc:        encrypt(leadEmail),
      emailSearchHash: searchHash(leadEmail),
      organisationEnc: organisation ? encrypt(organisation) : null,
      useCaseEnc:      useCaseDescription ? encrypt(useCaseDescription) : null,
      risk: verdict.risk || null,
      score: verdict.score || null,
      marketingConsent: Boolean(marketingConsent),
      ip: req.ip || null,
      ua: (req.headers['user-agent'] || '').slice(0, 200),
    },
  });

  // Best-effort verdict email.
  email.sendTemplate('article6Verdict', leadEmail, {
    verdict,
    organisation: organisation || null,
    useCaseDescription: useCaseDescription || null,
  }).catch((e) => console.error('[article6] verdict email failed:', e && e.message));

  res.status(202).json({ ok: true });
}));

module.exports = router;

