const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const { pool } = require('../db');
const { scrapeGSCDrilldown, getGscLastUpdatedDate, normaliseGscDate, PROFILE_DIR } = require('./gsc-scraper');

const router = express.Router();

const DEVICES  = ['Mobile', 'Desktop'];
const STATUSES = ['good', 'needs-improvement', 'poor'];

// ── Helpers ──────────────────────────────────────────────────────────────────

// Derive a stable URL pattern from an example URL.
// The pattern is used to track the same "group" across days even when GSC
// picks a different example URL (e.g. /reviews/sbp-consulting → /reviews/xyz).
// Rules:
//   - Leaf segment (last) → always replaced with *
//   - Intermediate segment → replaced with * if it contains hyphens or digits (slug-like)
//   - Short, plain-word intermediate segments (reviews, jobs, companies...) kept as-is
// Examples:
//   /reviews/sbp-consulting-reviews   → /reviews/*
//   /overview/tcs                     → /overview/*
//   /companies/tcs/reviews            → /companies/tcs/*
//   /salaries/infosys-salary          → /salaries/*
function derivePattern(exampleUrl) {
  if (!exampleUrl) return null;
  try {
    const { pathname } = new URL(exampleUrl);
    const segs = pathname.split('/').filter(Boolean);
    if (segs.length === 0) return '/';
    return '/' + segs.map((seg, i) => {
      if (i === segs.length - 1) return '*'; // leaf is always the entity
      return (seg.includes('-') || /\d/.test(seg)) ? '*' : seg;
    }).join('/');
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
async function backfillUrlPatterns() {
  try {
    const [rows] = await pool.execute(
      `SELECT id, example_url FROM cwv_url_groups WHERE url_pattern IS NULL OR url_pattern = '' LIMIT 50000`
    );
    if (!rows.length) return;
    console.log(`[cwv-db] Backfilling url_pattern for ${rows.length} rows...`);
    for (const row of rows) {
      const pattern = derivePattern(row.example_url);
      if (pattern) {
        await pool.execute(`UPDATE cwv_url_groups SET url_pattern = ? WHERE id = ?`, [pattern, row.id]);
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

// GET /api/cwv-db/trend?siteUrl=&urlPattern=&exampleUrl=&device=&status=
// Returns one data point per gsc_date for a specific URL group.
// exampleUrl narrows the query to that exact URL group so we don't aggregate
// metrics from unrelated groups that happen to share the same broad url_pattern
// (e.g. /salaries/* matches both the calculator page and every company salary page).
// When a URL has multiple issue rows on the same date (LCP issue + CLS issue),
// we still use MAX so all metrics surface even if split across issue rows.
router.get('/cwv-db/trend', async (req, res) => {
  const { siteUrl, urlPattern, exampleUrl, device, status } = req.query;
  if (!siteUrl)    return res.status(400).json({ error: 'siteUrl is required' });
  if (!urlPattern) return res.status(400).json({ error: 'urlPattern is required' });
  if (!device)     return res.status(400).json({ error: 'device is required' });
  if (!status)     return res.status(400).json({ error: 'status is required' });
  try {
    const conditions = [
      'site_url   = ?',
      'url_pattern = ?',
      'device      = ?',
      'status      = ?',
      'gsc_date IS NOT NULL',
    ];
    const params = [siteUrl, urlPattern, device, status];

    // When an exact example URL is provided, restrict to that specific URL group.
    // This prevents /salaries/* from aggregating metrics across dozens of unrelated pages.
    if (exampleUrl) {
      conditions.push('example_url = ?');
      params.push(exampleUrl);
    }

    const [rows] = await pool.query(
      `SELECT
         gsc_date,
         MAX(population)  AS population,
         MAX(lcp)         AS lcp,
         MAX(cls)         AS cls,
         MAX(inp)         AS inp
       FROM cwv_url_groups
       WHERE ${conditions.join(' AND ')}
       GROUP BY gsc_date
       ORDER BY gsc_date ASC`,
      params
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
