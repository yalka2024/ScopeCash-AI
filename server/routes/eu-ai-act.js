/**
 * EU AI Act classifier API (Tier 20).
 *
 *  POST /api/eu-ai-act/classify       — classify a single assessment input
 *                                       (public, rate-limited; used by the
 *                                       free wizard and by the app itself)
 *  GET  /api/eu-ai-act/enums          — return the input enums (sectors,
 *                                       data-sensitive, etc.) so the UI can
 *                                       build its forms from one source
 *  GET  /api/eu-ai-act/version        — current rule-engine version
 *
 * The classifier is deterministic — we expose it publicly because the rules
 * are public law and customers want to verify the verdict logic. For the
 * authenticated app, results are also persisted onto the related record by
 * the use-case routes (see routes/project.js).
 */
const express = require('express');
const { z, validate, asyncHandler } = require('../lib/validate');
const classifier = require('../lib/eu-ai-act-classifier');

const router = express.Router();

const ClassifySchema = z.object({
  description:    z.string().min(20).max(5000),
  sector:         z.enum(classifier.SECTORS),
  decisionImpact: z.enum(classifier.DECISION_IMPACTS),
  dataSensitive:  z.array(z.enum(classifier.DATA_SENSITIVE)).default([]),
  scope:          z.enum(classifier.DEPLOYMENT_SCOPES),
  providerRole:   z.enum(classifier.PROVIDER_ROLES),
});

router.post('/classify', validate(ClassifySchema), asyncHandler(async (req, res) => {
  try {
    const verdict = classifier.classify(req.body);
    res.json({ verdict });
  } catch (err) {
    if (err.code === 'invalid_assessment_input') {
      return res.status(400).json({ error: err.code, details: err.details });
    }
    throw err;
  }
}));

router.get('/enums', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    sectors:           classifier.SECTORS,
    decisionImpacts:   classifier.DECISION_IMPACTS,
    dataSensitive:     classifier.DATA_SENSITIVE,
    deploymentScopes:  classifier.DEPLOYMENT_SCOPES,
    providerRoles:     classifier.PROVIDER_ROLES,
  });
});

router.get('/version', (req, res) => {
  res.json({ version: classifier.VERSION });
});

module.exports = router;

