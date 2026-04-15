const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const router = express.Router();

const PROFILE_DIR = path.join(os.homedir(), '.cwv-browser-profile');

// device param: GSC uses device=2 for Mobile, device=1 for Desktop
const DEVICE_PARAM = { Mobile: '2', Desktop: '1' };


async function launchBrowser(headless = true) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    ignoreHTTPSErrors: true,
  });
}

// GET /api/gsc-auth-status
router.get('/gsc-auth-status', (req, res) => {
  res.json({ ready: fs.existsSync(PROFILE_DIR) });
});

// POST /api/gsc-setup — open visible browser for one-time login
router.post('/gsc-setup', async (req, res) => {
  let context;
  try {
    if (fs.existsSync(PROFILE_DIR)) fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    context = await launchBrowser(false);
    const page = await context.newPage();
    await page.goto('https://accounts.google.com/ServiceLogin?service=sitemaps', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    console.log('[gsc-setup] Waiting for user to log in...');
    await page.waitForFunction(
      () => window.location.href.includes('search.google.com/search-console'),
      null, { timeout: 180000 }
    );
    await page.waitForTimeout(2000);
    await context.close();
    res.json({ success: true });
  } catch (err) {
    if (context) await context.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gsc-scrape — scrape overview counts only (fast)
router.post('/gsc-scrape', async (req, res) => {
  const { siteUrl } = req.body;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  if (!fs.existsSync(PROFILE_DIR)) return res.status(401).json({ error: 'Browser not set up. Please complete setup first.' });

  let context;
  try {
    context = await launchBrowser(true);
    const page = await context.newPage();
    const encodedSite = encodeURIComponent(siteUrl);
    await page.goto(`https://search.google.com/search-console/core-web-vitals?resource_id=${encodedSite}`, {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    if (page.url().includes('accounts.google.com')) {
      await context.close();
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      return res.status(401).json({ error: 'Session expired. Please run setup again.' });
    }
    await page.waitForTimeout(4000);
    await page.screenshot({ path: '/tmp/gsc-cwv-debug.png', fullPage: true });

    const { groups, gscDate } = await extractOverviewCounts(page);
    console.log('[gsc-scrape] gscDate:', gscDate);
    await context.close();
    res.json({ groups, scrapedAt: new Date().toISOString(), gscDate });
  } catch (err) {
    if (context) await context.close().catch(() => {});
    console.error('[gsc-scrape] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Exported: scrape drilldown for one site+device+status, call onGroup per row
async function scrapeGSCDrilldown(siteUrl, device, status, onGroup = () => {}, onStatus = () => {}) {
  if (!fs.existsSync(PROFILE_DIR)) throw new Error('Browser not set up. Run GSC Setup first.');
  const context = await launchBrowser(true);
  const page = await context.newPage();
  const encodedSite = encodeURIComponent(siteUrl);
  const deviceParam = DEVICE_PARAM[device] || '2';

  try {
    if (status === 'good') {
      const drillUrl = `https://search.google.com/search-console/core-web-vitals/drilldown?resource_id=${encodedSite}&device=${deviceParam}`;
      await page.goto(drillUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (page.url().includes('accounts.google.com')) {
        fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
        throw new Error('Session expired. Please run setup again.');
      }
      await page.waitForSelector('table tbody tr', { timeout: 12000 }).catch(() => {});
      onStatus('Page loaded, scraping Good URL groups...');
      await clickAndCollect(page, onGroup);
    } else {
      const summaryUrl = `https://search.google.com/search-console/core-web-vitals/summary?resource_id=${encodedSite}&device=${deviceParam}`;
      await page.goto(summaryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (page.url().includes('accounts.google.com')) {
        fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
        throw new Error('Session expired. Please run setup again.');
      }
      await page.waitForSelector('table tbody tr', { timeout: 12000 }).catch(() => {});
      onStatus('Summary page loaded, finding issues...');
      await clickAndCollectSummary(page, status, onGroup, (_, d) => onStatus(d?.message || ''));
    }
  } finally {
    await context.close().catch(() => {});
  }
}

// GET /api/gsc-scrape-drilldown?siteUrl=&device=&status= — SSE stream of URL groups
router.get('/gsc-scrape-drilldown', async (req, res) => {
  const { siteUrl, device = 'Mobile', status = 'good' } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let isClosed = false;
  req.on('close', () => { isClosed = true; });
  const send = (event, data) => {
    if (isClosed || res.writableEnded) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  try {
    await scrapeGSCDrilldown(
      siteUrl, device, status,
      (group) => send('group', group),
      (msg)   => send('status', { message: msg }),
    );
    send('done', { scrapedAt: new Date().toISOString() });
    res.end();
  } catch (err) {
    console.error('[gsc-drilldown] Error:', err.message);
    send('error', { error: err.message });
    res.end();
  }
});

// POST /api/gsc-debug-drilldown — dumps paginator HTML from the drilldown page
router.post('/gsc-debug-drilldown', async (req, res) => {
  const { siteUrl, device = 'Mobile' } = req.body;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  let context;
  try {
    context = await launchBrowser(true);
    const page = await context.newPage();
    const encodedSite = encodeURIComponent(siteUrl);
    const deviceParam = DEVICE_PARAM[device] || '2';
    await page.goto(
      `https://search.google.com/search-console/core-web-vitals/drilldown?resource_id=${encodedSite}&device=${deviceParam}`,
      { waitUntil: 'domcontentloaded', timeout: 45000 }
    );
    await page.waitForTimeout(4000);
    const info = await page.evaluate(() => {
      // Dump bottom toolbar HTML (paginator lives there)
      const footer = document.querySelector('[data-paginate]')?.closest('div')?.parentElement;
      return {
        paginatorHtml: footer?.outerHTML?.slice(0, 3000) || '(not found)',
        bodyText: document.body.innerText.slice(0, 500),
        buttons100: Array.from(document.querySelectorAll('button, [role="option"]'))
          .filter(el => el.innerText?.trim() === '100')
          .map(el => el.outerHTML),
      };
    });
    await context.close();
    res.json(info);
  } catch (err) {
    if (context) await context.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gsc-debug
router.post('/gsc-debug', async (req, res) => {
  const { siteUrl } = req.body;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  let context;
  try {
    context = await launchBrowser(true);
    const page = await context.newPage();
    const encodedSite = encodeURIComponent(siteUrl);
    await page.goto(`https://search.google.com/search-console/core-web-vitals?resource_id=${encodedSite}`, {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await page.waitForTimeout(4000);
    const rawText = await page.evaluate(() => document.body.innerText);
    await context.close();
    res.json({ rawText });
  } catch (err) {
    if (context) await context.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function extractOverviewCounts(page) {
  const { rawText, reportLinks, gscDate } = await page.evaluate(() => ({
    rawText: document.body.innerText,
    reportLinks: Array.from(document.querySelectorAll('a'))
      .filter((a) => /core-web-vitals|report/i.test(a.href) && a.href !== window.location.href)
      .map((a) => a.href),
    // Grab the date GSC shows — try several label variants
    gscDate: (() => {
      const text = document.body.innerText;
      const m = text.match(/(?:Last update[d]?|Data updated|Updated)[:\s]+([A-Za-z0-9\/\-, ]+?)(?:\n|$)/i)
             || text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
      return m ? m[1].trim() : null;
    })(),
  }));

  const parseCount = (str) => parseInt(str.replace(/,/g, ''), 10);
  const results = [];
  const sectionRegex = /(Mobile|Desktop)\s+OPEN REPORT([\s\S]*?)(?=Mobile|Desktop|$)/gi;
  let match;

  while ((match = sectionRegex.exec(rawText)) !== null) {
    const formFactor = match[1];
    const body = match[2];
    const poorMatch = body.match(/([\d,]+)\s*poor\s*URLs?/i);
    const niMatch   = body.match(/([\d,]+)\s*URLs?\s*need\s*improvement/i) ||
                      body.match(/([\d,]+)\s*needs?\s*improvement/i);
    const goodMatch = body.match(/([\d,]+)\s*good\s*URLs?/i);

    const poor = poorMatch ? parseCount(poorMatch[1]) : 0;
    const ni   = niMatch   ? parseCount(niMatch[1])   : 0;
    const good = goodMatch ? parseCount(goodMatch[1]) : 0;

    const linkIdx = formFactor === 'Mobile' ? 0 : 1;
    const href = reportLinks[linkIdx] || reportLinks[0] || null;

    results.push({ label: 'Poor URLs',              formFactor, status: 'poor',             affectedCount: poor, href, urls: [] });
    results.push({ label: 'Needs Improvement URLs', formFactor, status: 'needs-improvement',affectedCount: ni,   href, urls: [] });
    results.push({ label: 'Good URLs',              formFactor, status: 'good',             affectedCount: good, href, urls: [] });
  }

  if (!results.length) {
    console.log('[gsc-scrape] Could not parse raw text:\n', rawText.slice(0, 800));
    results.push({ label: 'Could not parse', formFactor: 'unknown', status: 'unknown', affectedCount: null, href: null, urls: [] });
  }
  return { groups: results, gscDate };
}

// Navigate summary page → click each NI/Poor issue row → scrape per-issue drilldown
async function clickAndCollectSummary(page, status, onGroup, send) {
  // GSC summary page labels status as "Need improvement" or "Poor"
  const STATUS_TEXT = { 'needs-improvement': 'need improvement', poor: 'poor' };
  const targetText = STATUS_TEXT[status] || status;

  // Grab indices + labels of rows matching the target status
  const matchingRows = await page.evaluate((target) => {
    return Array.from(document.querySelectorAll('table tbody tr'))
      .map((row, i) => {
        const cells = Array.from(row.querySelectorAll('td'));
        // Issue name is typically in the 2nd cell (index 1)
        const label = cells[1]?.innerText?.trim() || cells[0]?.innerText?.trim() || `Issue ${i + 1}`;
        return { i, text: row.innerText.toLowerCase(), label };
      })
      .filter(({ text }) => text.includes(target));
  }, targetText);

  send('status', { message: `Found ${matchingRows.length} ${status} issue(s) on summary page` });

  if (matchingRows.length === 0) {
    const sample = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tbody tr')).slice(0, 6).map(r => r.innerText.trim().slice(0, 80))
    );
    console.log('[summary] No matching rows. Sample rows:', sample);
    return;
  }

  const summaryUrl = page.url();

  for (let j = 0; j < matchingRows.length; j++) {
    const { i: idx, label: issueLabel } = matchingRows[j];
    send('status', { message: `Opening issue ${j + 1} of ${matchingRows.length}: ${issueLabel}` });
    try {
      await page.locator('table tbody tr').nth(idx).click();
      await page.waitForTimeout(4000);

      send('status', { message: `Scraping URL groups for: ${issueLabel}` });
      await clickAndCollect(page, (group) => onGroup({ ...group, issueLabel }));

      // Return to summary for next issue
      if (j < matchingRows.length - 1) {
        await page.goto(summaryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
      }
    } catch (err) {
      console.error(`[summary] issue ${j} error:`, err.message);
      send('status', { message: `Issue ${j + 1} error: ${err.message}` });
      try {
        await page.goto(summaryUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
      } catch {}
    }
  }
}

// Click the "Rows per page" dropdown and select 100, before starting row scraping
async function selectMaxRowsPerPage(page) {
  try {
    // ── Step 1: open the rows-per-page dropdown ───────────────────────────────
    // GSC places a clickable current-page-size number next to the paginator arrows.
    // Try selectors in order of specificity.
    let opened = false;

    // (a) data-paginate attribute variants used by GSC
    for (const sel of ['[data-paginate="rows"]', '[data-rows-per-page]', '[data-paginate-rows]']) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await el.click();
        opened = true;
        break;
      }
    }

    // (b) Find the rows-per-page container by looking for "Rows per page" text,
    //     then click the adjacent current-count button/span
    if (!opened) {
      const rowsLabel = page.getByText('Rows per page:', { exact: false }).first();
      if (await rowsLabel.isVisible({ timeout: 1500 }).catch(() => false)) {
        // The clickable trigger is typically the sibling number element
        await rowsLabel.evaluate((el) => {
          const parent = el.closest('[class]') || el.parentElement;
          const trigger = parent?.querySelector('button, [role="button"], [tabindex="0"]')
                       || el.nextElementSibling;
          if (trigger) trigger.click();
          else el.click();
        });
        opened = true;
      }
    }

    if (!opened) {
      console.log('[drilldown] rows-per-page control not found — staying at default page size');
      return;
    }

    await page.waitForTimeout(600); // wait for dropdown to open

    // ── Step 2: click the "100" option ────────────────────────────────────────
    // Try standard role=option first, then broader selectors
    const selectors = [
      page.getByRole('option', { name: '100' }),
      page.locator('[role="listbox"] *').filter({ hasText: /^100$/ }),
      page.locator('[role="menu"] *').filter({ hasText: /^100$/ }),
      page.locator('li, [role="menuitem"]').filter({ hasText: /^100$/ }),
    ];

    for (const loc of selectors) {
      if (await loc.first().isVisible({ timeout: 800 }).catch(() => false)) {
        await loc.first().click();
        console.log('[drilldown] rows per page set to 100');
        // Wait for table to reload — detect when row count exceeds default 10
        await page.waitForFunction(
          () => document.querySelectorAll('table tbody tr').length > 10,
          { timeout: 8000 }
        ).catch(() => {});
        return;
      }
    }

    console.log('[drilldown] "100" option not visible in dropdown');
  } catch (e) {
    console.log('[drilldown] selectMaxRowsPerPage error:', e.message);
  }
}

// Parse a single XSBInd response text into LCP/CLS/INP/status
function parseXSBInd(text) {
  const STATUS_LABELS = { 1: 'good', 2: 'needs-improvement', 3: 'poor' };
  const match = text.match(/"XSBInd","((?:[^"\\]|\\.)*)"/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    const groupMetrics = parsed?.[3] || [];
    const getM = (id) => groupMetrics.find(m => Array.isArray(m) && m[0] === id);
    const lcpM = getM(3), clsM = getM(4), inpM = getM(5);
    const lcp = lcpM?.[1] != null ? `${(lcpM[1] / 1000).toFixed(1)}s` : null;
    const cls = clsM?.[1] != null ? `${(clsM[1] / 100).toFixed(2)}` : null;
    const inp = inpM?.[1] != null ? `${inpM[1]}ms` : null;
    const worstStatus = groupMetrics.reduce((w, m) => Math.max(w, m[2] || 0), 0);
    const status = STATUS_LABELS[worstStatus] || null;
    return { lcp, cls, inp, status };
  } catch { return {}; }
}

// Click all rows rapidly, collect XSBInd responses in parallel, emit groups as they resolve
async function clickAndCollect(page, onGroup = () => {}) {
  const allGroups = [];
  let hasMore = true;

  // Try to show 100 rows at once to minimise pagination
  await selectMaxRowsPerPage(page);

  // Read table header to know which metric column is already shown in the table
  const tableMetricKey = await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('table thead th, table thead td'));
    const headerText = headers.map(h => h.innerText?.trim().toLowerCase()).join('|');
    if (headerText.includes('cls')) return 'cls';
    if (headerText.includes('inp')) return 'inp';
    if (headerText.includes('lcp')) return 'lcp';
    return null;
  }).catch(() => null);
  console.log(`[drilldown] table metric column detected: ${tableMetricKey}`);

  while (hasMore) {
    const rowData = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tbody tr')).map((row) => {
        const cells = Array.from(row.querySelectorAll('td'));
        const urlEl = row.querySelector('a') || cells[0];
        const url = urlEl?.href || urlEl?.innerText?.trim() || '';
        const pop = parseInt((cells[1]?.innerText || '').replace(/,/g, ''), 10) || null;
        // cells[2] already contains the metric value (Group CLS / Group INP / Group LCP)
        const tableMetric = cells[2]?.innerText?.trim() || null;
        return { url, pop, tableMetric };
      }).filter(r => r.url.startsWith('http'))
    );

    if (rowData.length === 0) break;

    // ── Sequential with JS-native clicks ────────────────────────────────────
    // Playwright visibility checks fail once a detail panel is open.
    // page.evaluate → elem.click() bypasses that entirely since JS doesn't
    // care about visual coverage. We still go one-by-one so the panel state
    // is predictable and XSBInd responses map cleanly to their row.
    for (let i = 0; i < rowData.length; i++) {
      const { url: exampleUrl, pop: population, tableMetric } = rowData[i];
      let lcp = null, cls = null, inp = null, rowStatus = null;

      // Register listener BEFORE clicking
      let done = false;
      let resolveCapture;
      const capturePromise = new Promise(r => { resolveCapture = r; });
      const tid = setTimeout(() => {
        if (done) return;
        done = true;
        page.off('response', xsbHandler);
        resolveCapture(null);
      }, 5000); // 5 s — XSBInd normally arrives in < 2 s

      const xsbHandler = async (response) => {
        if (done || !response.url().includes('batchexecute')) return;
        try {
          const text = await response.text();
          if (text.includes('XSBInd')) {
            done = true;
            clearTimeout(tid);
            page.off('response', xsbHandler);
            resolveCapture(text);
          }
        } catch {}
      };
      page.on('response', xsbHandler);

      // Native JS click — ignores panel overlays and GSC's visibility state
      await page.evaluate((idx) => {
        const row = document.querySelectorAll('table tbody tr')[idx];
        if (row) row.click();
      }, i);

      const capturedText = await capturePromise;
      if (capturedText) {
        ({ lcp, cls, inp, status: rowStatus } = parseXSBInd(capturedText));
      } else {
        console.warn(`[drilldown] row ${i}: no XSBInd within 5s`);
      }

      // Fill metric from the table cell if XSBInd didn't provide it
      if (tableMetric && tableMetric !== '—') {
        if (tableMetricKey === 'cls' && !cls) cls = tableMetric;
        else if (tableMetricKey === 'inp' && !inp) inp = tableMetric;
        else if (tableMetricKey === 'lcp' && !lcp) lcp = tableMetric;
        // Auto-detect by format as final fallback
        else if (!cls && /^\d+\.\d+$/.test(tableMetric)) cls = tableMetric;
        else if (!inp && /^\d+ms$/i.test(tableMetric)) inp = tableMetric;
        else if (!lcp && /^\d+(\.\d+)?s$/i.test(tableMetric)) lcp = tableMetric;
      }

      // Close the detail panel so the next row is accessible
      try { await page.keyboard.press('Escape'); } catch {}
      await page.waitForTimeout(200);

      console.log(`[drilldown] row ${i} LCP:${lcp} CLS:${cls} INP:${inp}`);
      const group = { exampleUrl, population, lcp, cls, inp, status: rowStatus };
      allGroups.push(group);
      onGroup(group);
    }

    // ── Pagination ───────────────────────────────────────────────────────────
    hasMore = false;
    try {
      const nextBtn = page.locator('[data-paginate="next"]').first();
      if (await nextBtn.isVisible({ timeout: 1000 })) {
        const ariaDisabled = await nextBtn.getAttribute('aria-disabled');
        if (ariaDisabled !== 'true') {
          const firstUrlBefore = await page.evaluate(() => {
            const a = document.querySelector('table tbody tr a');
            return a ? a.href : '';
          });
          await nextBtn.click();
          await page.waitForFunction(
            (prev) => { const a = document.querySelector('table tbody tr a'); return a && a.href !== prev; },
            firstUrlBefore,
            { timeout: 10000 }
          ).catch(() => {});
          await page.waitForTimeout(300);
          hasMore = true;
        }
      }
    } catch { /* no next page */ }
  }

  return allGroups;
}

// Lightweight: open GSC overview, read gscDate, close. No drilldown scraping.
async function getGscLastUpdatedDate(siteUrl) {
  if (!fs.existsSync(PROFILE_DIR)) throw new Error('Browser not set up.');
  const context = await launchBrowser(true);
  const page = await context.newPage();
  try {
    const encodedSite = encodeURIComponent(siteUrl);
    await page.goto(
      `https://search.google.com/search-console/core-web-vitals?resource_id=${encodedSite}`,
      { waitUntil: 'domcontentloaded', timeout: 45000 }
    );
    if (page.url().includes('accounts.google.com')) {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      throw new Error('Session expired. Please run setup again.');
    }
    await page.waitForTimeout(4000);
    const { gscDate } = await extractOverviewCounts(page);
    return gscDate; // e.g. "4/12/26"
  } finally {
    await context.close().catch(() => {});
  }
}

// Normalise whatever GSC returns ("4/12/26", "Apr 12, 2026", etc.) → "YYYY-MM-DD"
function normaliseGscDate(raw) {
  if (!raw) return null;
  // M/D/YY or M/D/YYYY
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let [, m, d, y] = slash;
    if (y.length === 2) y = '20' + y;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  // Try native Date parse as fallback
  const parsed = new Date(raw);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  return raw; // return as-is if unparseable
}

module.exports = router;
module.exports.scrapeGSCDrilldown = scrapeGSCDrilldown;
module.exports.getGscLastUpdatedDate = getGscLastUpdatedDate;
module.exports.normaliseGscDate = normaliseGscDate;
module.exports.PROFILE_DIR = PROFILE_DIR;
