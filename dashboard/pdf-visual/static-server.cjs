/**
 * Minimal static file server for the pdf-visual test suite — no new
 * dependency for this, just Node's built-in http/fs. Serves the whole
 * dashboard/ directory (as the webServer's cwd) over real HTTP so
 * harness.html can load pdfjs-dist as an ES module: Chromium blocks
 * `<script type="module">` imports over file:// with a CORS error
 * ("origin 'null'"), but same-origin http:// imports work normally.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 4175;

const MIME = {
  '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.pdf': 'application/pdf', '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// Loopback-only: with no host argument Node binds all interfaces (0.0.0.0),
// which would serve this unauthenticated directory listing — the whole
// dashboard/ source tree, no route allowlist — to anyone on the local
// network for the duration of the test run.
server.listen(PORT, '127.0.0.1', () => console.log(`[pdf-visual static server] listening on http://localhost:${PORT}`));
