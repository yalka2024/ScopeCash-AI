/**
 * AI guardrails:
 *   - PII redaction on prompts (emails, phone, SSN, credit-card, IP)
 *   - Prompt-injection heuristic
 *   - Per-tenant token quota tracked in AiUsage (rolling 24h)
 *   - Output capping
 *
 * Usage:
 *   const guard = await checkAiQuota(prisma, ctx);
 *   if (!guard.ok) throw new HttpError(429, guard.reason, 'ai_quota');
 *   const safePrompt = redactPII(prompt);
 *   const ij = detectInjection(safePrompt);
 *   ...
 *   await recordAiUsage(prisma, ctx, { provider, model, prompt, ... });
 */
const crypto = require('crypto');
const metrics = require('./metrics');

// Order matters: the loose `phone` matcher also matches SSN/CC-shaped digit runs,
// so the more specific patterns (ssn, cc, ipv4) must run BEFORE phone — otherwise
// phone consumes "123-45-6789" and the ssn pass finds nothing.
const PII_PATTERNS = [
  { name: 'email',  rx: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,           tag: '[REDACTED_EMAIL]' },
  { name: 'ssn',    rx: /\b\d{3}-\d{2}-\d{4}\b/g,                            tag: '[REDACTED_SSN]' },
  { name: 'cc',     rx: /\b(?:\d[ -]*?){13,16}\b/g,                          tag: '[REDACTED_CC]' },
  { name: 'ipv4',   rx: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,                      tag: '[REDACTED_IP]' },
  { name: 'phone',  rx: /\+?\d[\d\s().-]{8,}\d/g,                            tag: '[REDACTED_PHONE]' },
];

function redactPII(text) {
  if (typeof text !== 'string') return { text, redactions: {} };
  let out = text; const counts = {};
  for (const p of PII_PATTERNS) {
    out = out.replace(p.rx, () => { counts[p.name] = (counts[p.name] || 0) + 1; return p.tag; });
  }
  return { text: out, redactions: counts };
}

const INJECTION_PATTERNS = [
  /ignore (?:all|previous) instructions/i,
  /disregard (?:the )?system prompt/i,
  /you are (?:now )?(?:dan|developer mode|jailbroken)/i,
  /reveal your (?:system )?prompt/i,
  /print your (?:initial|hidden) instructions/i,
  /\bact as\b.*\bunfiltered\b/i,
];
function detectInjection(text) {
  if (typeof text !== 'string') return { suspicious: false };
  for (const rx of INJECTION_PATTERNS) {
    if (rx.test(text)) return { suspicious: true, pattern: rx.source };
  }
  return { suspicious: false };
}

const DAILY_TOKEN_LIMIT = parseInt(process.env.AI_DAILY_TOKEN_LIMIT || '200000', 10);
const PER_REQUEST_INPUT_CHARS = parseInt(process.env.AI_MAX_INPUT_CHARS || '8000', 10);

async function checkAiQuota(prisma, ctx) {
  const since = new Date(Date.now() - 86400000);
  const where = ctx.orgId ? { orgId: ctx.orgId, createdAt: { gte: since } }
                          : { userId: ctx.userId, createdAt: { gte: since } };
  const agg = await prisma.aiUsage.aggregate({ where, _sum: { totalTokens: true } });
  const used = agg._sum.totalTokens || 0;
  if (used >= DAILY_TOKEN_LIMIT) {
    return { ok: false, reason: `Daily AI token quota exceeded (${used}/${DAILY_TOKEN_LIMIT})`, used, limit: DAILY_TOKEN_LIMIT };
  }
  return { ok: true, used, limit: DAILY_TOKEN_LIMIT };
}

function capInput(text) {
  if (typeof text !== 'string') return text;
  return text.length > PER_REQUEST_INPUT_CHARS ? text.slice(0, PER_REQUEST_INPUT_CHARS) : text;
}

function hashPrompt(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 32);
}

async function recordAiUsage(prisma, ctx, { provider, model, promptTokens = 0, completionTokens = 0, costUsd = 0, prompt, outcome = 'success' }) {
  await prisma.aiUsage.create({ data: {
    userId: ctx.userId, orgId: ctx.orgId || null,
    provider, model: model || null,
    promptTokens, completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd, outcome,
    promptHash: prompt ? hashPrompt(prompt) : null,
  }});
  metrics.counters.aiTokens.inc({ provider: provider || 'unknown', kind: 'prompt' }, promptTokens);
  metrics.counters.aiTokens.inc({ provider: provider || 'unknown', kind: 'completion' }, completionTokens);
}

module.exports = {
  redactPII, detectInjection, checkAiQuota, recordAiUsage, capInput,
  PER_REQUEST_INPUT_CHARS, DAILY_TOKEN_LIMIT,
};

