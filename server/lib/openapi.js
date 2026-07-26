// OpenAPI 3.1 spec for ScopeCash AI.
// Auto-generated structural skeleton — covers routes the generator emits.
// Extend per-route by adding entries in the relevant sections below.

const errorResp = {
  type: 'object',
  required: ['error', 'code'],
  properties: {
    error: { type: 'string' },
    code:  { type: 'string' },
    requestId: { type: 'string' },
    details: {}
  }
};

const cursorPage = (itemRef) => ({
  type: 'object',
  properties: {
    items: { type: 'array', items: itemRef },
    nextCursor: { type: ['string', 'null'] }
  },
  required: ['items']
});

const securitySchemes = {
  cookieAuth: { type: 'apiKey', in: 'cookie', name: 'access_token' },
  bearerAuth: { type: 'http',   scheme: 'bearer', bearerFormat: 'JWT' },
  apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' }
};

const standardErrors = {
  '400': { description: 'Bad request',          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '401': { description: 'Unauthorized',         content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '403': { description: 'Forbidden',            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '404': { description: 'Not found',            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '429': { description: 'Too many requests',    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '500': { description: 'Internal server error',content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
};

function buildSpec() {
  const CORE = 'projects';
  const Core = 'project';

  const schemas = {
    Error: errorResp,
    Health: { type: 'object', properties: { status: { type: 'string' }, uptime: { type: 'number' } } },
    User: {
      type: 'object',
      properties: {
        id: { type: 'string' }, email: { type: 'string', format: 'email' },
        role: { type: 'string', enum: ['admin', 'member', 'viewer'] },
        createdAt: { type: 'string', format: 'date-time' }
      }
    },
    LoginRequest: {
      type: 'object', required: ['email', 'password'],
      properties: { email: { type: 'string' }, password: { type: 'string' }, mfaCode: { type: 'string' } }
    },
    LoginResponse: {
      type: 'object',
      properties: {
        token: { type: 'string' }, refreshToken: { type: 'string' },
        user: { $ref: '#/components/schemas/User' }, mfaRequired: { type: 'boolean' }
      }
    },
    [Core]: {
      type: 'object',
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' },
        organizationId: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' }
      }
    },
    [`${Core}Page`]: cursorPage({ $ref: `#/components/schemas/${Core}` }),
    Webhook: {
      type: 'object',
      properties: {
        id: { type: 'string' }, url: { type: 'string', format: 'uri' },
        events: { type: 'array', items: { type: 'string' } },
        active: { type: 'boolean' }, secret: { type: 'string' }
      }
    },
    ApiKey: {
      type: 'object',
      properties: {
        id: { type: 'string' }, label: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string' } },
        prefix: { type: 'string' }, lastUsedAt: { type: ['string', 'null'], format: 'date-time' }
      }
    }
  };

  const cursorParams = [
    { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque cursor from previous page' },
    { name: 'limit',  in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }
  ];

  const paths = {
    '/api/health/live':  { get: { tags: ['Health'], summary: 'Liveness',  security: [], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } } } } },
    '/api/health/ready': { get: { tags: ['Health'], summary: 'Readiness', security: [], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } }, '503': { description: 'Not ready' } } } },

    '/api/auth/register': {
      post: {
        tags: ['Auth'], summary: 'Register new user', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } },
        responses: { '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } }, ...standardErrors }
      }
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Login (issues access_token cookie)', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } }, ...standardErrors }
      }
    },
    '/api/auth/refresh': { post: { tags: ['Auth'], summary: 'Rotate refresh token', security: [], responses: { '200': { description: 'OK' }, ...standardErrors } } },
    '/api/auth/logout':  { post: { tags: ['Auth'], summary: 'Logout', responses: { '204': { description: 'No Content' } } } },
    '/api/auth/me':      { get:  { tags: ['Auth'], summary: 'Current user', responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } }, ...standardErrors } } },
    '/api/auth/mfa/setup':  { post: { tags: ['Auth'], summary: 'Begin MFA enrolment', responses: { '200': { description: 'OK' }, ...standardErrors } } },
    '/api/auth/mfa/verify': { post: { tags: ['Auth'], summary: 'Verify MFA code',     responses: { '200': { description: 'OK' }, ...standardErrors } } },
    '/api/auth/password/reset':   { post: { tags: ['Auth'], summary: 'Request password reset', security: [], responses: { '202': { description: 'Accepted' } } } },
    '/api/auth/password/confirm': { post: { tags: ['Auth'], summary: 'Confirm password reset', security: [], responses: { '200': { description: 'OK' }, ...standardErrors } } },

    [`/api/${CORE}`]: {
      get:  { tags: [Core], summary: `List ${CORE}`, parameters: cursorParams, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: `#/components/schemas/${Core}Page` } } } }, ...standardErrors } },
      post: { tags: [Core], summary: `Create ${Core}`, requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${Core}` } } } }, responses: { '201': { description: 'Created', content: { 'application/json': { schema: { $ref: `#/components/schemas/${Core}` } } } }, ...standardErrors } }
    },
    [`/api/${CORE}/{id}`]: {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get:    { tags: [Core], summary: `Get ${Core}`, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: `#/components/schemas/${Core}` } } } }, ...standardErrors } },
      patch:  { tags: [Core], summary: `Update ${Core}`, requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${Core}` } } } }, responses: { '200': { description: 'OK' }, ...standardErrors } },
      delete: { tags: [Core], summary: `Delete ${Core}`, responses: { '204': { description: 'No Content' }, ...standardErrors } }
    },

    '/api/api-keys': {
      get:  { tags: ['ApiKeys'], summary: 'List API keys', responses: { '200': { description: 'OK' } } },
      post: { tags: ['ApiKeys'], summary: 'Issue API key', responses: { '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKey' } } } } } }
    },
    '/api/api-keys/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      delete: { tags: ['ApiKeys'], summary: 'Revoke API key', responses: { '204': { description: 'No Content' } } }
    },

    '/api/webhooks': {
      get:  { tags: ['Webhooks'], summary: 'List webhook subscriptions', responses: { '200': { description: 'OK' } } },
      post: { tags: ['Webhooks'], summary: 'Create webhook subscription', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Webhook' } } } }, responses: { '201': { description: 'Created' } } }
    },
    '/api/webhooks/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      patch:  { tags: ['Webhooks'], summary: 'Update webhook', responses: { '200': { description: 'OK' } } },
      delete: { tags: ['Webhooks'], summary: 'Delete webhook', responses: { '204': { description: 'No Content' } } }
    },

    '/api/orgs':   { get: { tags: ['Organizations'], summary: 'List orgs',   responses: { '200': { description: 'OK' } } } },
    '/api/billing/checkout': { post: { tags: ['Billing'], summary: 'Create checkout session', responses: { '200': { description: 'OK' }, ...standardErrors } } },
    '/api/billing/portal':   { post: { tags: ['Billing'], summary: 'Open customer portal',    responses: { '200': { description: 'OK' }, ...standardErrors } } },
    '/api/export':           { post: { tags: ['Export'],  summary: 'Schedule export job',     responses: { '202': { description: 'Accepted' }, ...standardErrors } } },
    '/api/analytics/summary':{ get:  { tags: ['Analytics'],summary: 'Aggregate summary',      responses: { '200': { description: 'OK' }, ...standardErrors } } },
    '/api/notifications':    { get:  { tags: ['Notifications'], summary: 'List notifications',responses: { '200': { description: 'OK' }, ...standardErrors } } },
    '/api/admin/audit':      { get:  { tags: ['Admin'],    summary: 'Audit log (admin only)',  responses: { '200': { description: 'OK' }, ...standardErrors } } }
  };

  
  paths['/api/ai/complete'] = {
    post: {
      tags: ['AI'], summary: 'AI completion (guardrailed)',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { prompt: { type: 'string' }, model: { type: 'string' } }, required: ['prompt'] } } } },
      responses: { '200': { description: 'OK' }, ...standardErrors }
    }
  };
  

  return {
    openapi: '3.1.0',
    info: {
      title: 'ScopeCash AI API',
      version: '1.0.0',
      description: 'OpenAPI specification for ScopeCash AI.',
      license: { name: 'Proprietary' }
    },
    servers: [
      { url: '/', description: 'Same-origin' },
      { url: 'http://localhost:4000', description: 'Local dev' }
    ],
    security: [{ cookieAuth: [] }, { bearerAuth: [] }, { apiKeyAuth: [] }],
    tags: [
      { name: 'Health' }, { name: 'Auth' }, { name: Core },
      { name: 'ApiKeys' }, { name: 'Webhooks' }, { name: 'Organizations' },
      { name: 'Billing' }, { name: 'Export' }, { name: 'Analytics' },
      { name: 'Notifications' }, { name: 'Admin' }, { name: 'AI' }
    ],
    components: { schemas, securitySchemes },
    paths
  };
}

const spec = buildSpec();

module.exports = { spec, buildSpec };

