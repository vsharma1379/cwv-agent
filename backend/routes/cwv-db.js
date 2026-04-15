const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const { pool } = require('../db');
const { scrapeGSCDrilldown, getGscLastUpdatedDate, normaliseGscDate, PROFILE_DIR } = require('./gsc-scraper');

const router = express.Router();

const DEVICES  = ['Mobile', 'Desktop'];
const STATUSES = ['good', 'needs-improvement', 'poor'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSites() {
  // Comma-separated list in env, e.g. "https://www.ambitionbox.com/,https://example.com/"
  const raw = process.env.GSC_SITES || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function saveGroups(siteUrl, device, status, groups, scrapedAt, gscDate) {
  if (!groups.length) return;
  const conn = await pool.getConnection();
  try {
    // Delete existing rows for this site+device+status+date before inserting
    // so re-running a scrape never creates duplicates
    const date = scrapedAt.slice(0, 10); // "YYYY-MM-DD"
    await conn.execute(
      `DELETE FROM cwv_url_groups
       WHERE site_url = ? AND device = ? AND status = ? AND DATE(scraped_at) = ?`,
      [siteUrl, device, status, date]
    );

    const values = groups.map(g => [
      siteUrl,
      device,
      status,
      g.exampleUrl,
      g.population ?? null,
      g.lcp ?? null,
      g.cls ?? null,
      g.inp ?? null,
      g.status ?? null,
      gscDate ?? null,
      scrapedAt,
    ]);
    await conn.query(
      `INSERT IGNORE INTO cwv_url_groups
         (site_url, device, status, example_url, population, lcp, cls, inp, row_status, gsc_date, scraped_at)
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

// GET /api/cwv-db/url-groups?siteUrl=&device=&status=&date=  (date = gsc_date)
router.get('/cwv-db/url-groups', async (req, res) => {
  const { siteUrl, device = 'Mobile', status = 'good', date } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  if (!date)    return res.status(400).json({ error: 'date is required' });
  try {
    const [rows] = await pool.execute(
      `SELECT example_url, population, lcp, cls, inp, row_status, gsc_date, scraped_at
       FROM cwv_url_groups
       WHERE site_url = ?
         AND device   = ?
         AND status   = ?
         AND gsc_date = ?
       ORDER BY population DESC`,
      [siteUrl, device, status, date]
    );
    res.json({ rows, total: rows.length });
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
