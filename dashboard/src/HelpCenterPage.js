import React, { useEffect, useMemo, useState } from 'react';

// Help-centre / docs site (Tier 24).
//
// Public, unauthenticated. Lives at #help and #help/<slug>. Renders categories
// → article list → article body (a tiny markdown subset: H1-H3, paragraphs,
// bullet lists, fenced code, inline `code`, **bold**, *italic*, [links](url)).
// No external deps so it works in air-gapped builds.

const API_BASE = process.env.REACT_APP_API_URL || '/api';

const PALETTE = {
  bg: 'hsl(222 47% 8%)',
  panel: 'hsl(222 47% 13%)',
  border: 'hsl(217 33% 24%)',
  text: 'hsl(210 40% 96%)',
  muted: 'hsl(215 20% 65%)',
  link: 'hsl(263 70% 75%)',
  brand: 'hsl(263 70% 68%)',
  code: 'hsl(217 33% 17%)',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Inline (after escaping): **bold**, *italic*, `code`, [text](url-or-#hash)
function renderInline(line) {
  let s = escapeHtml(line);
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code style="background:${PALETTE.code};padding:1px 6px;border-radius:4px;font-size:90%">${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
    const safeHref = /^(https?:|#|\/)/i.test(href) ? href : '#';
    const isExternal = /^https?:/i.test(safeHref);
    const attrs = isExternal ? 'target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${safeHref}" ${attrs} style="color:${PALETTE.link};text-decoration:underline">${text}</a>`;
  });
  return s;
}

// Block-level: render markdown subset to HTML string, returned via dangerouslySetInnerHTML.
function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre style="background:${PALETTE.code};padding:14px 18px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.5"><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = renderInline(h[2]);
      const sizes = { 1: '28px', 2: '22px', 3: '17px' };
      const margins = { 1: '24px 0 12px', 2: '28px 0 10px', 3: '20px 0 8px' };
      out.push(`<h${level} style="font-size:${sizes[level]};margin:${margins[level]};font-weight:700;color:${PALETTE.text}">${text}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li style="margin:4px 0">${renderInline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul style="margin:10px 0 14px;padding-left:24px;color:${PALETTE.text};line-height:1.65">${items.join('')}</ul>`);
      continue;
    }

    // Table (very small support: |a|b|\n|---|---|\n|x|y|)
    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s|:-]+\|$/.test(lines[i + 1])) {
      const head = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      const thead = `<thead><tr>${head.map((c) => `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid ${PALETTE.border};font-weight:600">${renderInline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td style="padding:8px 12px;border-bottom:1px solid ${PALETTE.border}">${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<table style="border-collapse:collapse;margin:14px 0;width:100%;font-size:14px">${thead}${tbody}</table>`);
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (greedy until blank/heading/list/code)
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3}\s|[-*]\s|```|\|)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p style="margin:10px 0;color:${PALETTE.text};line-height:1.65">${renderInline(buf.join(' '))}</p>`);
  }
  return out.join('');
}

function parseHelpHash() {
  const h = (window.location.hash || '').replace(/^#/, '');
  if (h === 'help' || h === '') return { slug: null };
  const m = /^help\/(.+)$/.exec(h);
  if (m) return { slug: m[1] };
  return { slug: null };
}

export default function HelpCenterPage({ onHome, onLogin }) {
  const [view, setView] = useState(parseHelpHash());
  const [categories, setCategories] = useState([]);
  const [articles, setArticles] = useState([]);
  const [article, setArticle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onHash = () => setView(parseHelpHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`${API_BASE}/help/categories`).then((r) => r.json()),
      fetch(`${API_BASE}/help/articles`).then((r) => r.json()),
    ])
      .then(([cats, arts]) => {
        if (!alive) return;
        setCategories(cats.categories || []);
        setArticles(arts.articles || []);
      })
      .catch((e) => alive && setError(e.message || 'Failed to load help centre'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    if (!view.slug) { setArticle(null); return; }
    setLoading(true);
    fetch(`${API_BASE}/help/articles/${encodeURIComponent(view.slug)}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Article not found' : `Failed (${r.status})`);
        return r.json();
      })
      .then((a) => alive && setArticle(a))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [view.slug]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter(
      (a) => a.title.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q),
    );
  }, [articles, query]);

  const grouped = useMemo(() => {
    const byCat = {};
    for (const a of filtered) {
      (byCat[a.category] ||= []).push(a);
    }
    return categories
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((c) => ({ category: c, items: byCat[c.id] || [] }))
      .filter((g) => g.items.length > 0);
  }, [filtered, categories]);

  return (
    <div style={{ background: PALETTE.bg, minHeight: '100vh', color: PALETTE.text, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <header style={{ background: PALETTE.panel, borderBottom: `1px solid ${PALETTE.border}`, padding: '14px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <a href="#" onClick={(e) => { e.preventDefault(); if (onHome) onHome(); else { window.location.hash = ''; } }} style={{ textDecoration: 'none', color: PALETTE.brand, fontWeight: 700, fontSize: 18 }}>
            ScopeCash AI
          </a>
          <span style={{ color: PALETTE.muted, fontSize: 14 }}>Help centre</span>
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <a href="#help" onClick={(e) => { e.preventDefault(); window.location.hash = '#help'; }} style={{ color: PALETTE.muted, fontSize: 14, textDecoration: 'none' }}>All articles</a>
          {onLogin && (
            <a href="#auth" onClick={(e) => { e.preventDefault(); onLogin(); }} style={{ color: PALETTE.link, fontSize: 14, textDecoration: 'none', fontWeight: 600 }}>
              Sign in
            </a>
          )}
        </div>
      </header>

      <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px 80px' }}>
        {error && (
          <div role="alert" style={{ background: '#fff5f5', border: '1px solid #fc8181', color: '#c53030', padding: 14, borderRadius: 8, marginBottom: 20 }}>
            {error}
          </div>
        )}

        {!view.slug && (
          <>
            <h1 style={{ fontSize: 34, fontWeight: 700, margin: '8px 0 6px' }}>How can we help?</h1>
            <p style={{ color: PALETTE.muted, fontSize: 16, marginBottom: 24 }}>
              Guides, walk-throughs and reference material for the ScopeCash AI platform.
            </p>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search articles..."
              aria-label="Search help articles"
              style={{ width: '100%', padding: '12px 16px', fontSize: 15, border: `1px solid ${PALETTE.border}`, borderRadius: 8, marginBottom: 28, outline: 'none', background: PALETTE.panel, color: PALETTE.text }}
            />

            {loading && <p style={{ color: PALETTE.muted }}>Loading articles...</p>}

            {!loading && grouped.length === 0 && (
              <p style={{ color: PALETTE.muted }}>No articles match "{query}".</p>
            )}

            {grouped.map(({ category, items }) => (
              <section key={category.id} style={{ marginBottom: 36 }}>
                <h2 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 1.2, color: PALETTE.muted, fontWeight: 600, margin: '0 0 14px' }}>
                  {category.title}
                </h2>
                <div style={{ display: 'grid', gap: 12 }}>
                  {items.map((a) => (
                    <a
                      key={a.slug}
                      href={`#help/${a.slug}`}
                      onClick={(e) => { e.preventDefault(); window.location.hash = `#help/${a.slug}`; }}
                      style={{ display: 'block', background: PALETTE.panel, border: `1px solid ${PALETTE.border}`, borderRadius: 10, padding: '16px 20px', textDecoration: 'none', color: PALETTE.text }}
                    >
                      <div style={{ fontSize: 16, fontWeight: 600, color: PALETTE.brand, marginBottom: 4 }}>{a.title}</div>
                      <div style={{ fontSize: 14, color: PALETTE.muted }}>{a.summary}</div>
                    </a>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}

        {view.slug && (
          <article>
            <a
              href="#help"
              onClick={(e) => { e.preventDefault(); window.location.hash = '#help'; }}
              style={{ display: 'inline-block', color: PALETTE.link, marginBottom: 18, fontSize: 14, textDecoration: 'none' }}
            >
              ← All help articles
            </a>
            {loading && <p style={{ color: PALETTE.muted }}>Loading article...</p>}
            {!loading && article && (
              <div style={{ background: PALETTE.panel, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: '32px 40px' }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1.2, color: PALETTE.muted, fontWeight: 600, marginBottom: 8 }}>
                  {(categories.find((c) => c.id === article.category) || {}).title || article.category}
                </div>
                <div style={{ color: PALETTE.muted, fontSize: 13, marginTop: 4, marginBottom: 12 }}>
                  Updated {article.updated_at}
                </div>
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(article.body) }} />
              </div>
            )}
          </article>
        )}
      </main>

      <footer style={{ borderTop: `1px solid ${PALETTE.border}`, padding: '20px 32px', textAlign: 'center', color: PALETTE.muted, fontSize: 13, background: PALETTE.panel }}>
        Can't find what you need? Email <a href="mailto:support@example.com" style={{ color: PALETTE.link }}>support@example.com</a>.
      </footer>
    </div>
  );
}

