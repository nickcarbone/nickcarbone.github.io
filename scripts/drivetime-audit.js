/**
 * drivetime-audit.js
 *
 * Nightly health check for the DRIVETIME page. Two jobs:
 *
 *  1. VIDEOS — checks every YouTube ID in the page's CITIES block.
 *     With YT_API_KEY set it uses the YouTube Data API (videos.list,
 *     1 quota unit per 50 IDs) and records: removed/private videos,
 *     embedding switched off, and countries where a video is blocked.
 *     Without a key it falls back to YouTube's public oEmbed endpoint,
 *     which only tells "plays embedded" from "doesn't".
 *
 *  2. STATIONS — builds a shortlist of local radio stations per city
 *     from Radio Browser: HTTPS streams whose name matches the city OR
 *     whose registered location is within 60 km of it, ranked by
 *     listener clicks, and confirmed to answer with audio from here.
 *     Existing picks that still work keep their place, so the list
 *     doesn't reshuffle every night.
 *
 * Results are written into the page itself, between the
 * AUDIT:BEGIN / AUDIT:END markers, so the page stays one file.
 * A human-readable report goes to drivetime-audit-report.md.
 *
 * Usage: node scripts/drivetime-audit.js [path-to-page.html]
 */

const fs = require('fs');
const vm = require('vm');

const FILE = process.argv[2] || process.env.DRIVETIME_FILE || 'drivetime-tesla.html';
const KEY = process.env.YT_API_KEY || '';
const RB = ['https://de1.api.radio-browser.info', 'https://all.api.radio-browser.info'];
const UA = 'drivetime-audit/1.0 (+https://nickcarbone.github.io)';
const RADIUS_KM = 60;
const KEEP = 12;            // stations stored per city
const STREAM_TIMEOUT = 7000;
const OUT = process.env.RUNNER_TEMP || process.env.AUDIT_OUT || '.';   // where the report goes (never committed)

const html = fs.readFileSync(FILE, 'utf8');

// ── Read CITIES and the previous AUDIT out of the page ──────────────────────
const citiesSrc = html.match(/const CITIES = (\[[\s\S]*?\n\]);/);
if (!citiesSrc) throw new Error('CITIES block not found in ' + FILE);
const CITIES = vm.runInNewContext(citiesSrc[1]);

const auditSrc = html.match(/\/\* AUDIT:BEGIN \*\/\s*const AUDIT = ([\s\S]*?);\s*\/\* AUDIT:END \*\//);
const PREV = auditSrc ? JSON.parse(auditSrc[1]) : { stations: {} };

// ── Helpers ─────────────────────────────────────────────────────────────────
async function getJSON(url, opts = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, ...opts });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}
async function rb(path) {
  let last;
  for (const base of RB) {
    try { return await getJSON(base + path); } catch (e) { last = e; }
  }
  throw last;
}
function km(aLat, aLng, bLat, bLng) {
  const r = x => x * Math.PI / 180, R = 6371;
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Does this URL answer with something that looks like an audio stream?
async function streamAnswers(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), STREAM_TIMEOUT);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Icy-MetaData': '0' }, signal: ctrl.signal, redirect: 'follow' });
    const type = (r.headers.get('content-type') || '').toLowerCase();
    ctrl.abort();                       // we only needed the headers
    return r.ok && /audio|ogg|mpegurl|aac|mpeg|octet-stream/.test(type);
  } catch (e) { return false; }
  finally { clearTimeout(t); }
}

// ── 1. Videos ───────────────────────────────────────────────────────────────
async function auditVideos() {
  const all = CITIES.flatMap(c => c.videos.map(v => ({ city: c.name, ...v })));
  const bad = {}, blocked = {}, notes = {};

  if (KEY) {
    for (let i = 0; i < all.length; i += 50) {
      const chunk = all.slice(i, i + 50);
      const ids = chunk.map(v => v.id).join(',');
      const data = await getJSON('https://www.googleapis.com/youtube/v3/videos?part=status,contentDetails&maxResults=50&id=' + ids + '&key=' + KEY);
      const byId = Object.fromEntries((data.items || []).map(it => [it.id, it]));
      for (const v of chunk) {
        const it = byId[v.id];
        if (!it) { bad[v.id] = 'removed or private'; continue; }
        const st = it.status || {}, cd = it.contentDetails || {};
        if (st.privacyStatus === 'private') bad[v.id] = 'private';
        else if (st.embeddable === false) bad[v.id] = 'embedding switched off';
        else if (st.uploadStatus && !['processed', 'uploaded'].includes(st.uploadStatus)) bad[v.id] = 'upload ' + st.uploadStatus;
        const rr = cd.regionRestriction;
        if (rr && (rr.blocked || rr.allowed)) blocked[v.id] = rr.blocked ? { blocked: rr.blocked } : { allowed: rr.allowed };
        if (cd.definition === 'sd') notes[v.id] = 'standard definition only';
      }
    }
  } else {
    await pool(all, 6, async v => {
      const u = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + v.id);
      try {
        const r = await fetch(u, { headers: { 'User-Agent': UA } });
        if (!r.ok) bad[v.id] = r.status === 404 ? 'removed or private' : 'won\'t embed (HTTP ' + r.status + ')';
      } catch (e) { /* network blip: don't condemn the video */ }
    });
  }
  return { bad, blocked, notes, all };
}

// ── 2. Stations ─────────────────────────────────────────────────────────────
/* "Local radio" means stations people in the city actually tune to, not
   the many internet-only genre streams that happen to register an
   address there. Popularity counts, but so do signs of a real
   broadcaster (a frequency, FM/AM, a US/Mexican callsign, the city in
   the name), and keyword-stuffed playlist names count against. */
const BROADCAST = /\b\d{2,3}[.,]\d\b|\b(fm|am|mhz)\b|\b[KWX][A-Z]{2,3}(-FM)?\b/i;
const PLAYLIST = /\b(sleep|relax|meditat|lounge|exclusively|chill|lo-?fi|nature|ambient|spa|yoga|top ?100|charts|mixtape|non-?stop|hits of|best of|only|radio for)\b|^[#_\W]/i;
function localScore(s, city) {
  const name = (s.name || '').trim();
  let score = Math.log10((s.clickcount || 0) + 1) * 2 + Math.log10((s.votes || 0) + 1);
  if (BROADCAST.test(name)) score += 3;
  if (norm(name).includes(norm(city.q)) || norm(name).includes(norm(city.name))) score += 2;
  if (/news|talk|public radio|community/i.test(s.tags || '')) score += 1;
  if (PLAYLIST.test(name)) score -= 4;
  if (name.length > 60) score -= 3;
  if ((name.match(/ - /g) || []).length >= 3) score -= 3;
  return score;
}
async function auditStations() {
  const byCountry = {};
  const out = {}, report = {};
  for (const c of CITIES) {
    if (!byCountry[c.cc]) {
      byCountry[c.cc] = await rb('/json/stations/search?limit=2000&hidebroken=true&is_https=true' +
        '&has_geo_info=true&order=clickcount&reverse=true&countrycode=' + c.cc);
    }
    const named = await rb('/json/stations/search?limit=200&hidebroken=true&is_https=true' +
      '&order=clickcount&reverse=true&countrycode=' + c.cc + '&name=' + encodeURIComponent(c.q));
    const near = byCountry[c.cc].filter(s => km(c.lat, c.lng, s.geo_lat, s.geo_long) <= RADIUS_KM);

    const seen = new Set(), seenName = new Set(), pool1 = [];
    const scored = [...named, ...near].map(s => ({ s, score: localScore(s, c) }));
    for (const { s, score } of scored.sort((a, b) => b.score - a.score)) {
      const n = norm(s.name);
      if (seen.has(s.stationuuid) || !n || seenName.has(n) || s.lastcheckok !== 1 || score < -2) continue;
      seen.add(s.stationuuid); seenName.add(n); pool1.push(s);
    }

    // Keep last night's picks that are still in the pool, in their order
    const prev = (PREV.stations && PREV.stations[c.name]) || [];
    const ranked = [
      ...prev.map(u => pool1.find(s => s.stationuuid === u)).filter(Boolean),
      ...pool1.filter(s => !prev.includes(s.stationuuid)),
    ].slice(0, 40);

    const ok = await pool(ranked, 8, s => streamAnswers(s.url_resolved || s.url));
    const keep = ranked.filter((s, i) => ok[i]).slice(0, KEEP);
    out[c.name] = keep.map(s => s.stationuuid);
    report[c.name] = { candidates: pool1.length, live: keep.length, names: keep.slice(0, 6).map(s => s.name.trim()) };
    console.log(`  ${c.name}: ${keep.length} live of ${pool1.length} local candidates`);
  }
  return { stations: out, report };
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Videos (' + (KEY ? 'YouTube Data API' : 'oEmbed fallback') + ')…');
  const v = await auditVideos();
  console.log('  ' + Object.keys(v.bad).length + ' broken, ' + Object.keys(v.blocked).length + ' region-restricted');

  console.log('Stations…');
  const s = await auditStations();

  const AUDIT = {
    checked: new Date().toISOString().slice(0, 10),
    method: KEY ? 'youtube-data-api' : 'oembed',
    bad: v.bad,
    blocked: v.blocked,
    stations: s.stations,
  };
  const block = '/* AUDIT:BEGIN */\nconst AUDIT = ' + JSON.stringify(AUDIT) + ';\n/* AUDIT:END */';
  let next;
  if (auditSrc) next = html.replace(/\/\* AUDIT:BEGIN \*\/[\s\S]*?\/\* AUDIT:END \*\//, () => block);
  else throw new Error('AUDIT markers not found in ' + FILE);

  // Only the date changed? Leave the file alone so there's no empty commit.
  const strip = t => t.replace(/"checked":"[^"]*",/, '');
  if (strip(next) !== strip(html)) fs.writeFileSync(FILE, next);
  else console.log('No material change.');

  // Report
  const lines = ['# DRIVETIME audit — ' + AUDIT.checked, '', 'Method: ' + AUDIT.method, ''];
  const badIds = Object.keys(v.bad);
  lines.push('## Videos that won\'t play (' + badIds.length + ')', '');
  if (!badIds.length) lines.push('None.');
  for (const id of badIds) {
    const x = v.all.find(a => a.id === id);
    lines.push(`- **${x.city}** · ${x.label} · \`${id}\` — ${v.bad[id]} · https://www.youtube.com/watch?v=${id}`);
  }
  const blk = Object.keys(v.blocked);
  lines.push('', '## Region-restricted videos (' + blk.length + ')', '');
  if (!blk.length) lines.push(KEY ? 'None.' : 'Needs the YouTube Data API key to check.');
  for (const id of blk) {
    const x = v.all.find(a => a.id === id), r = v.blocked[id];
    lines.push(`- **${x.city}** · ${x.label} · \`${id}\` — ` +
      (r.blocked ? 'blocked in ' + r.blocked.length + ' countries: ' + r.blocked.join(', ')
                 : 'only allowed in ' + r.allowed.length + ' countries'));
  }
  const notes = Object.keys(v.notes);
  if (notes.length) {
    lines.push('', '## Notes', '');
    for (const id of notes) { const x = v.all.find(a => a.id === id); lines.push(`- **${x.city}** · ${x.label} · \`${id}\` — ${v.notes[id]}`); }
  }
  lines.push('', '## Local stations per city', '', '| City | Live | Local candidates | Top picks |', '|---|---|---|---|');
  for (const [city, r] of Object.entries(s.report)) {
    lines.push(`| ${city} | ${r.live} | ${r.candidates} | ${r.names.join(' · ').replace(/\|/g, '/')} |`);
  }
  const thin = Object.entries(s.report).filter(([, r]) => r.live < 3).map(([c]) => c);
  if (thin.length) lines.push('', 'Thin local radio (fewer than 3 live, the page falls back to national stations): ' + thin.join(', '));
  fs.writeFileSync(OUT + '/drivetime-audit-report.md', lines.join('\n') + '\n');
  fs.writeFileSync(OUT + '/drivetime-audit-bad.txt', badIds.length ? 'yes' : '');
  console.log('Report written to ' + OUT + '/drivetime-audit-report.md');
})().catch(e => { console.error(e); process.exit(1); });
