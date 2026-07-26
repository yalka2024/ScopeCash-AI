/**
 * EU AI Act — Annex IV Technical Documentation Generator
 *
 * Annex IV (referenced by Article 11) lists the technical documentation that
 * providers of high-risk AI systems must draw up and keep up to date BEFORE
 * placing the system on the EU market.
 *
 * This module produces both:
 *   • generateJson(input)               -> structured object (machine-readable)
 *   • generatePdf(input, writableStream) -> human-readable PDF document
 *
 * Inputs:
 *   {
 *     record:       <ai_system or ai_use_case row from DB>,
 *     verdict:      <object from eu-ai-act-classifier.classify()>,
 *     organisation: { name, address, contactEmail, websiteUrl },
 *     extras: {                       // all optional, free-text user input
 *       description, intendedPurpose, version, releaseDate,
 *       hardwareRequirements, integrations,
 *       developmentProcess, designSpecs, validationProcedures,
 *       monitoringPlan, knownLimitations, foreseeableRisks,
 *       riskManagementMeasures,
 *       trainingDataSources, dataGovernance, biasMitigation,
 *       humanOversightMeasures,
 *       accuracyMetrics, robustnessMeasures, cybersecurityMeasures,
 *       postMarketMonitoringPlan,
 *       harmonisedStandards, conformityAssessmentRoute,
 *       euDeclarationOfConformity,
 *     }
 *   }
 *
 * The generator NEVER fabricates content. Missing sections are surfaced as
 * "[ TO BE COMPLETED — required by Annex IV §X ]" placeholders so the user can
 * see exactly what's still owed.
 */

const VERSION = '1.0.0';
const TODO    = (label) => `[ TO BE COMPLETED — required by Annex IV: ${label} ]`;

/* -------------------------------------------------------------------------- */
/*  Section definitions (mirrors Annex IV (a)–(i))                            */
/* -------------------------------------------------------------------------- */

const SECTIONS = [
  {
    id:    '1',
    annex: 'a',
    title: 'General description of the AI system',
    article: 'Article 11(1)',
    fields: [
      ['intendedPurpose',           'Intended purpose'],
      ['providerName',              'Name and address of the provider'],
      ['version',                   'Version of the system'],
      ['releaseDate',               'Date of release'],
      ['hardwareRequirements',      'Hardware on which the system is intended to run'],
      ['integrations',              'Integration into other systems / hardware'],
      ['userInterfaceDescription',  'Description of the user interface'],
      ['instructionsForUse',        'Instructions for use for deployers'],
    ],
  },
  {
    id:    '2',
    annex: 'b',
    title: 'Detailed description of elements & development process',
    article: 'Article 11(1)',
    fields: [
      ['developmentProcess',  'Methods and steps performed for development'],
      ['designSpecs',         'Design specifications and key design choices'],
      ['systemArchitecture',  'System architecture explanation'],
      ['computationalResources', 'Computational resources used to develop, train, test, and validate the system'],
    ],
  },
  {
    id:    '3',
    annex: 'c',
    title: 'Information on monitoring, functioning and control',
    article: 'Article 11(1)',
    fields: [
      ['capabilitiesAndLimits', 'Capabilities and limitations of the system'],
      ['expectedAccuracyLevel', 'Expected level of accuracy'],
      ['foreseeableUnintendedOutcomes', 'Foreseeable unintended outcomes and sources of risk'],
      ['monitoringPlan',        'Specifications on input data and the monitoring plan'],
    ],
  },
  {
    id:    '4',
    annex: 'd',
    title: 'Risk management system',
    article: 'Article 9',
    fields: [
      ['riskIdentification',     'Identification and analysis of known and foreseeable risks'],
      ['riskEstimation',         'Estimation and evaluation of risks that may emerge when the system is used'],
      ['riskManagementMeasures', 'Adopted risk management measures'],
      ['residualRiskCommunication', 'Communication of residual risks to deployers'],
    ],
  },
  {
    id:    '5',
    annex: 'e',
    title: 'Data and data governance',
    article: 'Article 10',
    fields: [
      ['trainingDataSources',     'Origin of training, validation, and testing data'],
      ['dataGovernance',          'Data governance and management practices'],
      ['dataLabellingProcedure',  'Data labelling procedures (where applicable)'],
      ['dataCleaningProcedure',   'Data cleaning methods and assumptions'],
      ['biasMitigation',          'Examination and mitigation of possible biases'],
      ['gapsAndShortcomings',     'Identification of relevant data gaps or shortcomings'],
    ],
  },
  {
    id:    '6',
    annex: 'f',
    title: 'Human oversight measures',
    article: 'Article 14',
    fields: [
      ['humanOversightMeasures',  'Description of human oversight measures designed and built in'],
      ['interpretationGuidance',  'Technical measures put in place to facilitate the interpretation of the system\'s outputs by deployers'],
      ['overrideMechanism',       'Mechanism enabling the deployer to intervene, override or stop the system'],
    ],
  },
  {
    id:    '7',
    annex: 'g',
    title: 'Accuracy, robustness and cybersecurity',
    article: 'Article 15',
    fields: [
      ['accuracyMetrics',         'Metrics used to measure accuracy and the levels of accuracy achieved'],
      ['robustnessMeasures',      'Resilience to errors, faults, inconsistencies, and unexpected situations'],
      ['biasFeedbackLoopsControl','Mitigation of biased outputs that may influence input for future operations (feedback loops)'],
      ['cybersecurityMeasures',   'Cybersecurity measures put in place'],
    ],
  },
  {
    id:    '8',
    annex: 'h',
    title: 'Risk management system update procedure',
    article: 'Article 9(2) & 11(1)',
    fields: [
      ['updateProcedure',         'Procedure used to update the risk management system over the lifetime of the system'],
      ['changeLog',               'Documented changes since previous version of the technical documentation'],
    ],
  },
  {
    id:    '9',
    annex: 'i',
    title: 'Standards applied & conformity',
    article: 'Articles 40, 43, 47',
    fields: [
      ['harmonisedStandards',         'List of harmonised standards applied in full or in part'],
      ['otherTechnicalSpecs',         'Other relevant technical specifications applied'],
      ['conformityAssessmentRoute',   'Conformity assessment procedure followed (Article 43)'],
      ['euDeclarationOfConformity',   'EU declaration of conformity (Article 47) — copy or reference'],
      ['postMarketMonitoringPlan',    'Post-market monitoring plan (Article 72)'],
    ],
  },
];

/* -------------------------------------------------------------------------- */
/*  generateJson                                                              */
/* -------------------------------------------------------------------------- */

function generateJson({ record, verdict, organisation = {}, extras = {} }) {
  if (!record || !record.id) throw new Error('annex-iv: record is required');
  if (!verdict)              throw new Error('annex-iv: verdict is required');

  const merged = { ...extras };
  // Auto-populate where the database / classifier already knows the answer
  if (!merged.providerName && organisation.name) {
    merged.providerName = `${organisation.name}${organisation.address ? ', ' + organisation.address : ''}`;
  }
  if (!merged.intendedPurpose && verdict.reasoning && verdict.reasoning.length) {
    merged.intendedPurpose = `${record.ai_systemName || record.ai_use_caseName || 'AI system'} — ${verdict.reasoning[0]}`;
  }

  const completeness = _completeness(merged);
  const sections = SECTIONS.map(sec => ({
    id:      sec.id,
    annex:   sec.annex,
    title:   sec.title,
    article: sec.article,
    fields:  sec.fields.map(([key, label]) => ({
      key,
      label,
      value:    merged[key] && String(merged[key]).trim() ? String(merged[key]).trim() : null,
      missing:  !(merged[key] && String(merged[key]).trim()),
      placeholder: TODO(`§${sec.annex} — ${label}`),
    })),
  }));

  return {
    documentVersion: VERSION,
    documentType:    'EU AI Act Annex IV Technical Documentation',
    generatedAt:     new Date().toISOString(),
    aiSystem: {
      id:    record.id,
      name:  record.ai_systemName || record.ai_use_caseName || 'Unnamed AI system',
      uniqueIdentifier: record.id,
    },
    classification: {
      verdict:     verdict.verdict,
      severity:    verdict.severity,
      title:       verdict.title,
      score:       verdict.score,
      articles:    verdict.articles || [],
      annexPoints: verdict.annexPoints || [],
      isGPAI:      !!verdict.isGPAI,
      systemicRisk:!!verdict.systemicRisk,
      engineVersion: verdict.version,
      assessedAt:  verdict.assessedAt,
    },
    organisation,
    sections,
    completeness,
    obligations: verdict.obligations || [],
  };
}

function _completeness(merged) {
  let total = 0; let filled = 0;
  for (const sec of SECTIONS) {
    for (const [key] of sec.fields) {
      total++;
      if (merged[key] && String(merged[key]).trim()) filled++;
    }
  }
  return { total, filled, percentage: total ? Math.round((filled / total) * 100) : 0 };
}

/* -------------------------------------------------------------------------- */
/*  generatePdf                                                               */
/* -------------------------------------------------------------------------- */

function generatePdf(input, stream) {
  const PDFDocument = require('pdfkit');
  const data = generateJson(input);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title:    `Annex IV Technical Documentation — ${data.aiSystem.name}`,
      Author:   data.organisation.name || 'AI System Provider',
      Subject:  'EU AI Act Annex IV Technical Documentation',
      Keywords: 'EU AI Act, Annex IV, Article 11, technical documentation, conformity',
      Creator:  `Annex IV Generator v${VERSION}`,
    },
  });

  doc.pipe(stream);

  // ── Cover page ──────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#0f172a')
     .text('Technical Documentation', { align: 'left' })
     .moveDown(0.2);
  doc.font('Helvetica').fontSize(13).fillColor('#475569')
     .text('drawn up in accordance with Annex IV and Article 11 of', { align: 'left' })
     .text('Regulation (EU) 2024/1689 — the "EU AI Act"', { align: 'left' })
     .moveDown(2);

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a')
     .text(data.aiSystem.name).moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#64748b')
     .text(`Unique identifier: ${data.aiSystem.uniqueIdentifier}`)
     .moveDown(2);

  // Risk badge
  const sevColor = { red: '#dc2626', orange: '#ea580c', yellow: '#ca8a04', green: '#16a34a' }[data.classification.severity] || '#64748b';
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff');
  const badge = ` ${data.classification.verdict.toUpperCase()} — ${data.classification.title} `;
  const badgeWidth = doc.widthOfString(badge) + 6;
  doc.rect(60, doc.y, badgeWidth, 20).fill(sevColor);
  doc.fillColor('#fff').text(badge, 63, doc.y - 16, { width: badgeWidth, align: 'left' });
  doc.moveDown(2);

  // Provider block
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Provider:');
  doc.font('Helvetica').fontSize(10).fillColor('#334155')
     .text(data.organisation.name    || TODO('§a — Provider name'))
     .text(data.organisation.address || TODO('§a — Provider address'))
     .text(data.organisation.contactEmail || '')
     .text(data.organisation.websiteUrl || '')
     .moveDown(1);

  doc.font('Helvetica').fontSize(9).fillColor('#94a3b8')
     .text(`Document generated on ${new Date(data.generatedAt).toLocaleString()}`)
     .text(`Documentation completeness: ${data.completeness.filled}/${data.completeness.total} fields (${data.completeness.percentage}%)`)
     .text(`Classification engine: v${data.classification.engineVersion}`)
     .text(`Generator: v${data.documentVersion}`);

  // ── Table of contents ───────────────────────────────
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a').text('Contents').moveDown(0.5);
  doc.font('Helvetica').fontSize(10).fillColor('#334155');
  for (const sec of data.sections) {
    doc.text(`§${sec.annex}.  ${sec.title}`, { indent: 10 })
       .font('Helvetica-Oblique').fontSize(9).fillColor('#64748b')
       .text(`     (${sec.article})`, { indent: 10 })
       .font('Helvetica').fontSize(10).fillColor('#334155')
       .moveDown(0.3);
  }

  // ── Sections ────────────────────────────────────────
  for (const sec of data.sections) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a')
       .text(`§${sec.annex}.  ${sec.title}`).moveDown(0.1);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#64748b')
       .text(sec.article).moveDown(1);

    for (const f of sec.fields) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1e293b').text(f.label);
      if (f.missing) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#dc2626')
           .text(f.placeholder, { indent: 8 });
      } else {
        doc.font('Helvetica').fontSize(10).fillColor('#334155')
           .text(f.value, { indent: 8, align: 'justify' });
      }
      doc.moveDown(0.6);
    }
  }

  // ── Obligations appendix ────────────────────────────
  if (data.obligations.length) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a')
       .text('Appendix A — Applicable Obligations').moveDown(1);
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    for (const o of data.obligations) {
      doc.font('Helvetica-Bold').fillColor('#1e293b').text(`Article ${o.article} — ${o.title}`);
      doc.font('Helvetica').fillColor('#475569').fontSize(9)
         .text(o.summary || '', { indent: 8 })
         .moveDown(0.4);
      doc.fontSize(10).fillColor('#334155');
    }
  }

  // ── Footer / signature page ─────────────────────────
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a')
     .text('Declaration').moveDown(1);
  doc.font('Helvetica').fontSize(10).fillColor('#334155')
     .text('The undersigned, on behalf of the provider, declares that the technical documentation above accurately describes the AI system identified on the cover page, and that the system complies with all applicable requirements of Regulation (EU) 2024/1689 (the "EU AI Act") at the time of signature.', { align: 'justify' })
     .moveDown(3);
  doc.text('Signature:').moveDown(2).text('______________________________').moveDown(1);
  doc.text('Name:').moveDown(0.5).text('Position:').moveDown(0.5).text('Date:');

  doc.end();
}

module.exports = { generateJson, generatePdf, SECTIONS, VERSION };

