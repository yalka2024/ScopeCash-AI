/**
 * Catalog of notification types a user can manage preferences for — the
 * single source of truth the preferences routes read to know what to show,
 * even before a user has any NotificationPreference rows (absence of a row
 * for a type just means "use its default", not "this type doesn't exist").
 * Type strings must match exactly what callers pass to
 * lib/notifications.js#notifyUser (lifecycle-triggers.js's KINDS values,
 * 'packet.approved', etc.).
 */
const NOTIFICATION_TYPES = [
  { type: 'lifecycle.day1_nudge', label: 'Getting started reminder', description: "A nudge if you haven't created your first project a day after signing up." },
  { type: 'lifecycle.day3_reengage', label: 'Re-engagement reminder', description: "A reminder if you haven't logged back in a few days after signing up." },
  { type: 'lifecycle.trial_ending', label: 'Trial ending soon', description: 'A heads-up a couple of days before your trial ends.' },
  { type: 'lifecycle.ai_budget_warn', label: 'AI budget warning', description: "A notice when your org's AI usage approaches its budget." },
  { type: 'packet.approved', label: 'Evidence packet approved', description: 'When an evidence packet you created is approved.' },
];

module.exports = { NOTIFICATION_TYPES };
