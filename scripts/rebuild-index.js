/**
 * rebuild-index.js
 * Fetches all public GitHub Pages repos for nickcarbone,
 * writes pages.json and sitemap.xml to the root repo.
 *
 * Runs inside GitHub Actions; requires GH_TOKEN env var.
 */

const https  = require('https');
const fs     = require('fs');

const USERNAME = 'nickcarbone';
const BASE_URL = `https://${USERNAME}.github.io`;
const TOKEN    = process.env.GH_TOKEN;

// ── Utility: make authenticated GitHub API request ──────────────────────────
function apiGet(path) {
  return new Promise((resolve, reject) => {
    https.request(
      {
        hostname: 'api.github.com',
        path,
        headers: {
          Authorization:  `token ${TOKEN}`,
          'User-Agent':   'rebuild-index-action',
          Accept:         'application/vnd.github.v3+json',
        },
      },
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, data: res.statusCode === 200 ? JSON.parse(body) : null })
        );
      }
    )
    .on('error', reject)
    .end();
  });
}

// ── Utility: convert slug to readable title ──────────────────────────────────
function toTitle(slug) {
  const CAPS = {
    nola: 'NOLA', nyc: 'NYC', dc: 'DC', uk: 'UK', us: 'US',
    csr: 'CSR', osint: 'OSINT', html: 'HTML', ai: 'AI', fifa: 'FIFA',
  };
  return slug
    .split('-')
    .map(w => CAPS[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// ── Utility: strip publisher boilerplate from repo description ───────────────
function cleanDescription(raw) {
  if (!raw) return '';
  // "Published via Publisher · https://nickcarbone.github.io/slug/" → ''
  // The Publisher writes the URL with or without a scheme; strip either form
  const out = raw.replace(/^Published via Publisher\s*[·•]?\s*(?:https?:\/\/)?(?:\S*github\.io\S*)?\s*/i, '').trim();
  return /^(?:https?:\/\/)?\S*github\.io\/\S*$/i.test(out) ? '' : out;
}

// ── Repos to always exclude from the page list ───────────────────────────────
const EXCLUDE = new Set([
  `${USERNAME}.github.io`,  // root repo itself
  'worldsfrontpage',         // Python pipeline, not a rendered page
  'breaking-wall',           // pre-publisher project, confirm manually if needed
  'global-news-monitor',     // pre-publisher project
]);

// ── Daily: hub + pieces from daily/manifest.json (lives in this repo) ────────
function dailyUrls() {
  let pieces = [];
  try { pieces = JSON.parse(fs.readFileSync('daily/manifest.json', 'utf8')).pieces || []; }
  catch (e) { return []; }
  const entry = (loc, lastmod, priority) => `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>${priority}</priority>
  </url>`;
  const latest = pieces[0] ? pieces[0].date : new Date().toISOString().split('T')[0];
  return [
    entry(`${BASE_URL}/daily/`, latest, '0.9'),
    ...pieces.map(p => entry(`${BASE_URL}/daily/${p.slug}/`, p.date, '0.7')),
  ];
}

// ── Catalogue: categories, tags and hidden flags (catalog.json) ──────────────
function loadCatalog() {
  let cat = { categories: [], pages: [] };
  try { cat = JSON.parse(fs.readFileSync('catalog.json', 'utf8')); }
  catch (e) { console.log('  ! catalog.json missing or invalid; every page is Unsorted'); }
  const bySlug = new Map((cat.pages || []).map(e => [e.slug, e]));
  const rootPages = (cat.pages || []).filter(e => e.url);
  return { categories: cat.categories || [], bySlug, rootPages };
}

function applyEntry(page, entry, categories) {
  return {
    ...page,
    title:       entry.title || page.title,
    description: entry.description || page.description || '',
    category:    categories.includes(entry.category) ? entry.category : 'Unsorted',
    tags:        Array.isArray(entry.tags) ? entry.tags : [],
  };
}

// ── For pages not in the catalogue: read the page's own meta tags ────────────
function fetchText(url, redirects = 3) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': 'rebuild-index-action' }, timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(''); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 300000) req.destroy(); });
      res.on('end', () => resolve(body));
      res.on('close', () => resolve(body));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(''));
  });
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function metaContent(html, name) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const n = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i);
    if (!n || n[1].toLowerCase() !== name) continue;
    const c = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    if (c) return decodeEntities((c[1] ?? c[2]).trim());
  }
  return '';
}

async function readPageMeta(url) {
  const html = await fetchText(url);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const category = metaContent(html, 'nc:category');
  return {
    category: category ? category.charAt(0).toUpperCase() + category.slice(1).toLowerCase() : '',
    tags: metaContent(html, 'nc:tags').split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
    hidden: /^(true|yes|1)$/i.test(metaContent(html, 'nc:hidden')),
    title: decodeEntities(title.replace(/\s+/g, ' ').trim()).split(/\s+[—|·]\s+/)[0],
    description: metaContent(html, 'description') || metaContent(html, 'og:description'),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Fetch all public repos (handles pagination)
  const allRepos = [];
  let page = 1;
  while (true) {
    const { data } = await apiGet(
      `/users/${USERNAME}/repos?per_page=100&page=${page}&type=public`
    );
    if (!data || data.length === 0) break;
    allRepos.push(...data);
    if (data.length < 100) break;
    page++;
  }
  console.log(`  ${allRepos.length} public repos found`);

  // 2. Filter obvious non-page repos before hitting Pages API
  const candidates = allRepos.filter(r =>
    !EXCLUDE.has(r.name) &&
    r.language !== 'Python' &&
    r.language !== 'JavaScript' &&
    r.language !== 'Ruby'
  );
  console.log(`  ${candidates.length} candidates after language filter`);

  // 3. Check each candidate for Pages enablement (batched, 8 concurrent)
  const results = [];
  const BATCH = 8;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const checks = await Promise.all(
      batch.map(async repo => {
        const { status } = await apiGet(`/repos/${USERNAME}/${repo.name}/pages`);
        if (status !== 200) return null;
        return {
          slug:        repo.name,
          url:         `${BASE_URL}/${repo.name}/`,
          title:       toTitle(repo.name),
          description: cleanDescription(repo.description),
          updated:     repo.pushed_at,
          created:     repo.created_at,
        };
      })
    );
    results.push(...checks.filter(Boolean));
  }

  console.log(`  ${results.length} pages with GitHub Pages enabled`);

  // 4. Classify every page from catalog.json, falling back to the page's own
  //    <meta name="nc:category"> / <meta name="nc:tags">, then to Unsorted.
  const { categories, bySlug, rootPages } = loadCatalog();
  const classified = [];
  for (const p of results) {
    const entry = bySlug.get(p.slug);
    if (entry) {
      if (entry.hidden) continue;
      classified.push(applyEntry(p, entry, categories));
      continue;
    }
    const meta = await readPageMeta(p.url);
    if (meta.hidden) continue;
    classified.push({
      ...p,
      title:       meta.title || p.title,
      description: p.description || meta.description || '',
      category:    categories.includes(meta.category) ? meta.category : 'Unsorted',
      tags:        meta.tags,
    });
  }
  // Pages that live as files in this repo, which repo discovery can't see
  for (const entry of rootPages) {
    if (entry.hidden) continue;
    classified.push(applyEntry({
      slug: entry.slug, url: entry.url, title: entry.title, description: '',
      updated: entry.created, created: entry.created,
    }, entry, categories));
  }
  results.length = 0;
  results.push(...classified);

  // 5. Sort newest-first by creation date (a bot commit shouldn't reorder)
  results.sort((a, b) => new Date(b.created) - new Date(a.created));
  const unsorted = results.filter(p => p.category === 'Unsorted').map(p => p.slug);
  console.log(`  ${results.length} pages listed, ${unsorted.length} unsorted${unsorted.length ? ': ' + unsorted.join(', ') : ''}`);

  // ── Write pages.json ───────────────────────────────────────────────────────
  const pagesJson = {
    generated: new Date().toISOString(),
    count:     results.length,
    pages:     results,
  };
  fs.writeFileSync('pages.json', JSON.stringify(pagesJson, null, 2) + '\n');
  console.log('  ✓ pages.json written');

  // ── Write sitemap.xml ──────────────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0];
  const urlEntries = [
    // Root landing page
    `  <url>
    <loc>${BASE_URL}/</loc>
    <lastmod>${today}</lastmod>
    <priority>1.0</priority>
  </url>`,
    // Daily hub and its pieces (folders inside this repo, not separate repos)
    ...dailyUrls(),
    // All published pages
    ...results.map(p => `  <url>
    <loc>${p.url}</loc>
    <lastmod>${p.updated.split('T')[0]}</lastmod>
    <priority>0.8</priority>
  </url>`),
  ];

  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urlEntries,
    '</urlset>',
    '',
  ].join('\n');

  fs.writeFileSync('sitemap.xml', sitemap);
  console.log('  ✓ sitemap.xml written');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
