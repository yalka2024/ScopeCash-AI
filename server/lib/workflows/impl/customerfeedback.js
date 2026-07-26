'use strict';

const realImplemented = true;

// stepIndex (0-based) -> async (state, ctx) => string | JSON-serializable
const steps = {};

/**
 * Step 1 (index 0): Request post-delivery rating after packet is marked delivered.
 * Builds a structured feedback request payload for the customer.
 */
steps[0] = async (state, ctx) => {
  let parsed = {};
  try { parsed = state ? JSON.parse(state) : {}; } catch (_) {}

  const projectId = parsed.projectId || ctx?.projectId || null;
  const customerName = parsed.customerName || ctx?.customerName || 'Valued Customer';
  const deliveredAt = parsed.deliveredAt || ctx?.deliveredAt || new Date().toISOString();

  const feedbackRequest = {
    step: 'rating_request',
    projectId,
    customerName,
    deliveredAt,
    prompt: `Hi ${customerName}, your project packet has been marked as delivered. On a scale of 1–5, how would you rate your overall experience?`,
    ratingScale: { min: 1, max: 5, labels: { 1: 'Poor', 2: 'Fair', 3: 'Good', 4: 'Very Good', 5: 'Excellent' } },
    awaitingField: 'rating',
    feedback: parsed.feedback || {},
    consent: parsed.consent || {},
    submitted: false,
  };

  return JSON.stringify(feedbackRequest);
};

/**
 * Step 2 (index 1): Ask whether the packet saved time, identified undocumented work, and was submitted.
 * Appends structured follow-up questions to the existing state.
 */
steps[1] = async (state, ctx) => {
  let parsed = {};
  try { parsed = state ? JSON.parse(state) : {}; } catch (_) {}

  const followUpQuestions = [
    {
      id: 'saved_time',
      question: 'Did the scope packet save you time during the project?',
      type: 'boolean',
    },
    {
      id: 'identified_undocumented_work',
      question: 'Did the packet help identify undocumented or out-of-scope work?',
      type: 'boolean',
    },
    {
      id: 'was_submitted',
      question: 'Was the packet formally submitted to your client or stakeholder?',
      type: 'boolean',
    },
  ];

  const updated = {
    ...parsed,
    step: 'follow_up_questions',
    followUpQuestions,
    awaitingField: 'follow_up_answers',
    feedback: {
      ...(parsed.feedback || {}),
      // Preserve any existing answers; new answers will be merged by the runtime/agent
    },
  };

  return JSON.stringify(updated);
};

/**
 * Step 3 (index 2): Request testimonial consent separately with explicit opt-in.
 * Generates a consent record with a clear opt-in flag defaulting to false.
 */
steps[2] = async (state, ctx) => {
  let parsed = {};
  try { parsed = state ? JSON.parse(state) : {}; } catch (_) {}

  const consentRequest = {
    ...parsed,
    step: 'testimonial_consent',
    consent: {
      ...(parsed.consent || {}),
      askedAt: new Date().toISOString(),
      prompt:
        'We would love to share your experience with others. Do you consent to us using your feedback as a testimonial? ' +
        'Your name and any project details will NEVER be published without your explicit approval.',
      consentGiven: false,          // explicit opt-in; must be affirmatively set
      allowName: false,             // separate flag: may we use your name?
      allowProjectDetails: false,   // separate flag: may we reference project details?
      consentRecordedAt: null,
    },
    awaitingField: 'consent',
  };

  return JSON.stringify(consentRequest);
};

/**
 * Step 4 (index 3): Store feedback linked to project; never publish name or evidence without consent.
 * Produces a final sanitised feedback record ready for persistence.
 * Strips identifying information unless consent was explicitly granted.
 */
steps[3] = async (state, ctx) => {
  let parsed = {};
  try { parsed = state ? JSON.parse(state) : {}; } catch (_) {}

  const consent = parsed.consent || {};
  const feedback = parsed.feedback || {};
  const followUpAnswers = parsed.followUpAnswers || {};

  // Build the safe storage record
  const record = {
    step: 'store_feedback',
    projectId: parsed.projectId || null,
    deliveredAt: parsed.deliveredAt || null,
    storedAt: new Date().toISOString(),
    rating: feedback.rating !== undefined ? feedback.rating : null,
    savedTime: followUpAnswers.saved_time !== undefined ? followUpAnswers.saved_time : null,
    identifiedUndocumentedWork: followUpAnswers.identified_undocumented_work !== undefined
      ? followUpAnswers.identified_undocumented_work
      : null,
    wasSubmitted: followUpAnswers.was_submitted !== undefined ? followUpAnswers.was_submitted : null,
    // Only include identifying info when consent was explicitly given
    customerName: consent.consentGiven && consent.allowName ? (parsed.customerName || null) : null,
    testimonialText: consent.consentGiven ? (feedback.testimonialText || null) : null,
    projectDetails: consent.consentGiven && consent.allowProjectDetails
      ? (feedback.projectDetails || null)
      : null,
    consent: {
      consentGiven: !!consent.consentGiven,
      allowName: !!consent.allowName,
      allowProjectDetails: !!consent.allowProjectDetails,
      consentRecordedAt: consent.consentRecordedAt || null,
      askedAt: consent.askedAt || null,
    },
    publishable: !!(consent.consentGiven),
    // Safety note stored with record
    _policy: 'Name and project evidence must not be published unless consentGiven=true and the relevant allowX flag is true.',
  };

  return JSON.stringify(record);
};

module.exports = { realImplemented, steps, workflow: "CustomerFeedback" };
