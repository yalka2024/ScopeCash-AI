const router = require('express').Router();
const { spec } = require('../lib/openapi');

// Serve raw spec (machine-readable)
router.get('/openapi.json', (_req, res) => {
  res.type('application/json').send(JSON.stringify(spec, null, 2));
});

// Serve Swagger UI via CDN (no extra dependency).
// In hardened deployments, host the assets locally and tighten CSP.
router.get('/', (_req, res) => {
  // Relax CSP just for this HTML so the CDN bundle can load.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
    "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
    "img-src 'self' data: https://cdn.jsdelivr.net; " +
    "connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ScopeCash AI API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: './openapi.json',
        dom_id: '#swagger',
        deepLinking: true,
        persistAuthorization: true
      });
    };
  </script>
</body>
</html>`);
});

module.exports = router;

