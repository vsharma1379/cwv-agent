const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const { pool } = require('../db');
const { scrapeGSCDrilldown, getGscLastUpdatedDate, normaliseGscDate, PROFILE_DIR } = require('./gsc-scraper');

const router = express.Router();

const DEVICES  = ['Mobile', 'Desktop'];
const STATUSES = ['good', 'needs-improvement', 'poor'];

// ── Helpers ──────────────────────────────────────────────────────────────────

// Suffixes that identify the TYPE of entity in a URL segment (sorted longest-first
// so the most specific suffix wins on endsWith checks).
// e.g. "hdfc-bank-interview-questions" → *-interview-questions
const ENTITY_TYPE_SUFFIXES = [
  '-interview-questions',
  '-salaries',
  '-salary',
  '-reviews',
  '-review',
  '-overview',
  '-offices',
  '-office',
  '-locations',
  '-location',
  '-photos',
  '-photo',
  '-benefits',
  '-benefit',
  '-discussions',
  '-discussion',
  '-interviews',
  '-interview',
  '-jobs',
  '-job',
  '-working',
  '-ratings',
  '-rating',
  '-designations',
  '-designation',
  '-people',
  '-about',
  '-organisations',
  '-organisation',
];

// Plain single-word structural terms — section/page-type words that are NOT
// variable entity values. Always kept verbatim.
const STRUCTURAL_WORDS = new Set([
  'salaries', 'reviews', 'overview', 'jobs', 'companies', 'interview',
  'interviews', 'locations', 'offices', 'people', 'working', 'benefits',
  'photos', 'about', 'designations', 'questions', 'ratings', 'compare',
  'search', 'profile', 'profiles', 'fresher', 'experienced', 'organisation',
  'organisations', 'discussions', 'question', 'candidates',
]);

// Hyphenated terms that are structural page-type or filter words (not entity values).
const STRUCTURAL_HYPHENATED = new Set([
  'interview-questions',
  'fresher-candidates',
  'experienced-candidates',
]);

// Specific page slugs that should never be wildcarded (known static tool/feature pages).
const STATIC_PAGES = new Set([
  'take-home-salary-calculator',
]);

// Classify one URL path segment (not the root section segment) into a pattern token.
function classifySegment(seg) {
  // Strip trailing numeric IDs like "-294737" or "-101025502502"
  const stripped = seg.replace(/-\d+$/, '');

  // 1. Known entity-type suffix → preserve the type suffix, wildcard the entity prefix
  //    e.g. "hdfc-bank-interview-questions" → "*-interview-questions"
  for (const suffix of ENTITY_TYPE_SUFFIXES) {
    if (stripped.endsWith(suffix) && stripped.length > suffix.length) {
      return '*' + suffix;
    }
  }

  // 2. Known hyphenated structural terms → keep verbatim
  if (STRUCTURAL_HYPHENATED.has(stripped)) return stripped;

  // 3. Known static tool/feature pages → keep verbatim
  if (STATIC_PAGES.has(stripped)) return stripped;

  // 4. Known single-word structural terms → keep verbatim
  if (STRUCTURAL_WORDS.has(stripped)) return stripped;

  // 5. Everything else → wildcard.
  //    Covers: plain role/entity words ("teacher", "analyst", "tcs"),
  //    hyphenated slugs without a known type suffix ("blackrock-vs-goldman-sachs"),
  //    and any other variable entity values.
  return '*';
}

// Derive a stable URL pattern from an example URL.
//
// Path: the FIRST segment (section root) is always kept verbatim.
//       Every subsequent segment is classified by classifySegment().
//
// Query string: param KEYS are kept, values are wildcarded (→ "key=*").
//               Keys are sorted alphabetically for a stable pattern regardless
//               of the order GSC returns them in.
//               e.g. ?page=6&tag=appraisal → ?page=*&tag=*
//
// Examples:
//   /salaries/physicswallah-salaries/teacher       → /salaries/*-salaries/*
//   /salaries/pine-labs-salaries/software-developer → /salaries/*-salaries/*   ← same group
//   /salaries/take-home-salary-calculator          → /salaries/take-home-salary-calculator
//   /reviews/sbp-consulting-reviews                → /reviews/*-reviews
//   /reviews/cipla-appraisal-reviews-294737?page=6 → /reviews/*-reviews?page=*
//   /reviews/genpact-reviews?rid=123&page=2&tag=x  → /reviews/*-reviews?page=*&rid=*&tag=*
//   /overview/tcs-overview/locations/bengaluru-offices → /overview/*-overview/locations/*-offices
//   /overview/pwc-overview/locations/bengaluru-offices → /overview/*-overview/locations/*-offices ← same
//   /profile/fresher-salary/bengaluru-location     → /profile/*-salary/*-location
//   /profile/general-manager-salary/bangalore-location?IndustryName=banking&page=2
//                                                  → /profile/*-salary/*-location?IndustryName=*&page=*
//   /interviews/hdfc-bank-interview-questions      → /interviews/*-interview-questions
//   /interviews/new-relic-interview-questions/fresher-candidates
//                                                  → /interviews/*-interview-questions/fresher-candidates
//   /salaries/deloitte-salaries/analyst/bengaluru-location → /salaries/*-salaries/*/*-location
//   /companies-in-bengaluru                        → /companies-in-bengaluru
//   /search?q=something                            → /search?q=*
function derivePattern(exampleUrl) {
  if (!exampleUrl) return null;
  try {
    const url = new URL(exampleUrl);
    const segs = url.pathname.split('/').filter(Boolean);

    // Build path pattern
    const pathPattern = segs.length === 0
      ? '/'
      : '/' + segs.map((seg, i) => i === 0 ? seg : classifySegment(seg)).join('/');

    // Build query pattern: keep keys, wildcard values, sort keys for stability
    const queryPattern = url.searchParams.size > 0
      ? '?' + [...url.searchParams.keys()].sort().map(k => `${k}=*`).join('&')
      : '';

    return pathPattern + queryPattern;
  } catch {
    return null;
  }
}

function getSites() {
  // Comma-separated list in env, e.g. "https://www.ambitionbox.com/,https://example.com/"
  const raw = process.env.GSC_SITES || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function saveGroups(siteUrl, device, status, groups, scrapedAt, gscDate) {
  if (!groups.length) return;
  const conn = await pool.getConnection();
  try {
    // Delete all existing rows for this site+device+status+gsc_date before inserting
    // so re-scraping always replaces stale data for the same GSC date
    await conn.execute(
      `DELETE FROM cwv_url_groups
       WHERE site_url = ? AND device = ? AND status = ? AND gsc_date = ?`,
      [siteUrl, device, status, gscDate]
    );

    const values = groups.map(g => [
      siteUrl,
      device,
      status,
      g.exampleUrl,
      derivePattern(g.exampleUrl),
      g.population ?? null,
      g.lcp ?? null,
      g.cls ?? null,
      g.inp ?? null,
      g.status ?? null,
      g.issueLabel ?? '',
      gscDate ?? null,
      scrapedAt,
    ]);
    await conn.query(
      `INSERT INTO cwv_url_groups
         (site_url, device, status, example_url, url_pattern, population, lcp, cls, inp, row_status, issue_label, gsc_date, scraped_at)
       VALUES ?`,
      [values]
    );
    console.log(`[cwv-db] saved ${groups.length} rows for ${device}/${status}`);
  } finally {
    conn.release();
  }
}

// Scrape one device+status combo and save to DB
async function scrapeAndSave(siteUrl, device, status, scrapedAt, gscDate) {
  const groups = [];
  console.log(`[cron] scraping ${siteUrl} ${device} ${status}...`);
  await scrapeGSCDrilldown(
    siteUrl, device, status,
    (group) => groups.push(group),
    (msg)   => console.log(`[cron]   ${msg}`),
  );
  await saveGroups(siteUrl, device, status, groups, scrapedAt, gscDate);
  return groups.length;
}

// Check if we already have data for this gsc_date in the DB
async function alreadyScraped(siteUrl, gscDateNorm) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) as cnt FROM cwv_url_groups WHERE site_url = ? AND gsc_date = ? LIMIT 1`,
    [siteUrl, gscDateNorm]
  );
  return rows[0].cnt > 0;
}

// Full nightly scrape for one site — skips if GSC data hasn't changed since last scrape
async function runNightlyScrape(siteUrl) {
  const scrapedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // Step 1: fetch the GSC "Last update" date (fast — just opens the overview page)
  console.log(`[cron] checking GSC last-update date for ${siteUrl}...`);
  const rawGscDate = await getGscLastUpdatedDate(siteUrl);
  const gscDateNorm = normaliseGscDate(rawGscDate); // → "YYYY-MM-DD"
  console.log(`[cron] GSC last update: ${rawGscDate} → normalised: ${gscDateNorm}`);

  if (!gscDateNorm) {
    console.warn('[cron] Could not read GSC date — skipping scrape to avoid bad data');
    return;
  }

  // Step 2: check DB — if we already have rows for this gsc_date, skip
  if (await alreadyScraped(siteUrl, gscDateNorm)) {
    console.log(`[cron] Already have data for gsc_date=${gscDateNorm} — skipping scrape`);
    return;
  }

  // Step 3: new GSC date → scrape all 6 combos and save
  console.log(`[cron] New GSC data (${gscDateNorm}) — scraping ${DEVICES.length * STATUSES.length} combos...`);
  let total = 0;
  for (const device of DEVICES) {
    for (const status of STATUSES) {
      try {
        const n = await scrapeAndSave(siteUrl, device, status, scrapedAt, gscDateNorm);
        total += n;
      } catch (err) {
        console.error(`[cron] ${device}/${status} failed:`, err.message);
      }
    }
  }
  console.log(`[cron] done — ${total} rows saved for ${siteUrl} (gsc_date=${gscDateNorm})`);
}

// ── Backfill url_pattern for rows inserted before the column was added ────────
// Re-derives url_pattern for ALL existing rows using the current derivePattern logic.
// Must be re-run (by incrementing PATTERN_VERSION) whenever derivePattern changes.
const PATTERN_VERSION = 3;

async function backfillUrlPatterns() {
  try {
    const [rows] = await pool.execute(
      `SELECT id, example_url FROM cwv_url_groups
       WHERE pattern_version IS NULL OR pattern_version < ?
       LIMIT 50000`,
      [PATTERN_VERSION]
    );
    if (!rows.length) {
      console.log('[cwv-db] url_pattern backfill: all rows up to date');
      return;
    }
    console.log(`[cwv-db] Re-deriving url_pattern for ${rows.length} rows (v${PATTERN_VERSION})...`);
    for (const row of rows) {
      const pattern = derivePattern(row.example_url);
      if (pattern) {
        await pool.execute(
          `UPDATE cwv_url_groups SET url_pattern = ?, pattern_version = ? WHERE id = ?`,
          [pattern, PATTERN_VERSION, row.id]
        );
      }
    }
    console.log('[cwv-db] url_pattern backfill complete');
  } catch (err) {
    console.error('[cwv-db] backfill error:', err.message);
  }
}
// Run once on startup (non-blocking)
backfillUrlPatterns();

// ── Cron: midnight every day ──────────────────────────────────────────────────
// Default: "0 0 * * *" (midnight server time). Override via CRON_SCHEDULE env.
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 0 * * *';

cron.schedule(CRON_SCHEDULE, async () => {
  const sites = getSites();
  if (!sites.length) {
    console.log('[cron] No GSC_SITES configured — skipping nightly scrape');
    return;
  }
  if (!fs.existsSync(PROFILE_DIR)) {
    console.log('[cron] Browser profile not set up — skipping nightly scrape');
    return;
  }
  console.log(`[cron] Starting nightly scrape for ${sites.length} site(s)...`);
  for (const site of sites) {
    await runNightlyScrape(site).catch(err => console.error('[cron] site error:', err.message));
  }
});

console.log(`[cwv-db] Nightly cron scheduled: ${CRON_SCHEDULE}`);

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/cwv-db/trigger-scrape  — manual trigger
// Body: { siteUrl, force? }  — force=true skips the "already scraped" check
router.post('/cwv-db/trigger-scrape', async (req, res) => {
  const { siteUrl, force = false } = req.body;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });

  try {
    const scrapedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Step 1: read actual GSC "Last update" date (opens browser — takes ~10s)
    const rawGscDate  = await getGscLastUpdatedDate(siteUrl);
    const gscDateNorm = normaliseGscDate(rawGscDate);
    console.log(`[trigger] GSC last update: ${rawGscDate} → ${gscDateNorm}`);

    if (!gscDateNorm) {
      return res.status(500).json({ error: 'Could not read GSC last-update date. Check browser session.' });
    }

    // Step 2: check if we already have this date in DB
    if (!force && await alreadyScraped(siteUrl, gscDateNorm)) {
      return res.json({
        message: `Already up to date — DB has data for GSC date ${gscDateNorm}. No scrape needed.`,
        gscDate: gscDateNorm,
        skipped: true,
      });
    }

    // Step 3: new data — respond immediately, scrape in background
    res.json({
      message: `New GSC data found (${gscDateNorm}) — scraping 6 combos in background. Refresh dates in a few minutes.`,
      gscDate: gscDateNorm,
      skipped: false,
    });

    for (const d of DEVICES) {
      for (const s of STATUSES) {
        await scrapeAndSave(siteUrl, d, s, scrapedAt, gscDateNorm)
          .catch(err => console.error(`[trigger] ${d}/${s}:`, err.message));
      }
    }
    console.log(`[trigger] done — gsc_date=${gscDateNorm}`);
  } catch (err) {
    console.error('[trigger] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /api/cwv-db/dates?siteUrl=  — list available GSC data dates (source of truth)
router.get('/cwv-db/dates', async (req, res) => {
  const { siteUrl } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT gsc_date AS date
       FROM cwv_url_groups
       WHERE site_url = ? AND gsc_date IS NOT NULL
       ORDER BY gsc_date DESC
       LIMIT 90`,
      [siteUrl]
    );
    res.json(rows.map(r => r.date));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cwv-db/url-groups?siteUrl=&date=&device=&status=  (device and status are optional)
router.get('/cwv-db/url-groups', async (req, res) => {
  const { siteUrl, date, device, status } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  if (!date)    return res.status(400).json({ error: 'date is required' });
  try {
    const conditions = ['site_url = ?', 'gsc_date = ?'];
    const params = [siteUrl, date];
    if (device) { conditions.push('device = ?'); params.push(device); }
    if (status) { conditions.push('status = ?'); params.push(status); }

    const [rows] = await pool.query(
      `SELECT device, status, issue_label, example_url, url_pattern, population, lcp, cls, inp, row_status, gsc_date, scraped_at
       FROM cwv_url_groups
       WHERE ${conditions.join(' AND ')}
       ORDER BY device, status, issue_label, population DESC`,
      params
    );
    res.json({ rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cwv-db/trend?siteUrl=&urlPattern=&device=&status=
// Returns one data point per gsc_date for a given url_pattern+device+status.
// Each url_pattern is precise enough (query params included) to identify exactly
// one logical URL group. MAX() only exists to handle the edge case where one URL
// has multiple issue-label rows on the same date (e.g. LCP-issue + CLS-issue rows).
router.get('/cwv-db/trend', async (req, res) => {
  const { siteUrl, urlPattern, device, status } = req.query;
  if (!siteUrl)    return res.status(400).json({ error: 'siteUrl is required' });
  if (!urlPattern) return res.status(400).json({ error: 'urlPattern is required' });
  if (!device)     return res.status(400).json({ error: 'device is required' });
  if (!status)     return res.status(400).json({ error: 'status is required' });
  try {
    const [rows] = await pool.execute(
      `SELECT
         gsc_date,
         MAX(population) AS population,
         MAX(lcp)        AS lcp,
         MAX(cls)        AS cls,
         MAX(inp)        AS inp
       FROM cwv_url_groups
       WHERE site_url    = ?
         AND url_pattern = ?
         AND device      = ?
         AND status      = ?
         AND gsc_date IS NOT NULL
       GROUP BY gsc_date
       ORDER BY gsc_date ASC`,
      [siteUrl, urlPattern, device, status]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cwv-db/summary?siteUrl=&date=  (date = gsc_date)
router.get('/cwv-db/summary', async (req, res) => {
  const { siteUrl, date } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  if (!date)    return res.status(400).json({ error: 'date is required' });
  try {
    const [rows] = await pool.execute(
      `SELECT device, status, COUNT(*) AS group_count, SUM(population) AS total_urls, MAX(scraped_at) AS scraped_at
       FROM cwv_url_groups
       WHERE site_url = ? AND gsc_date = ?
       GROUP BY device, status`,
      [siteUrl, date]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
