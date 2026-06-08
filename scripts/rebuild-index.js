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
  return raw.replace(/^Published via Publisher\s*[·•·]\s*(https?:\/\/[^\s]*)?\s*/i, '').trim();
}

// ── Repos to always exclude from the page list ───────────────────────────────
const EXCLUDE = new Set([
  `${USERNAME}.github.io`,  // root repo itself
  'worldsfrontpage',         // Python pipeline, not a rendered page
  'breaking-wall',           // pre-publisher project, confirm manually if needed
  'global-news-monitor',     // pre-publisher project
]);

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

  // 4. Sort newest-first
  results.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  console.log(`  ${results.length} pages with GitHub Pages enabled`);

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
