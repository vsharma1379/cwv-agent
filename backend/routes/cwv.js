const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const router = express.Router();

const getAuth = (accessToken) => {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
};

const getAccessToken = (req) => req.headers['x-access-token'] || req.headers['authorization']?.replace('Bearer ', '');

// GET /api/sites — list all GSC sites for the user
router.get('/sites', async (req, res) => {
  const accessToken = getAccessToken(req);
  if (!accessToken) return res.status(401).json({ error: 'Missing access token' });

  try {
    const auth = getAuth(accessToken);
    const webmasters = google.webmasters({ version: 'v3', auth });
    const { data } = await webmasters.sites.list();
    res.json(data.siteEntry || []);
  } catch (err) {
    console.error('Sites error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/urls?siteUrl=&startDate=&endDate= — top URLs from GSC Search Analytics
router.get('/urls', async (req, res) => {
  const accessToken = getAccessToken(req);
  if (!accessToken) return res.status(401).json({ error: 'Missing access token' });

  const { siteUrl, startDate, endDate } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });

  const end = endDate || new Date().toISOString().split('T')[0];
  const start = startDate || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().split('T')[0];
  })();

  try {
    const auth = getAuth(accessToken);
    const webmasters = google.webmasters({ version: 'v3', auth });
    const { data } = await webmasters.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: start,
        endDate: end,
        dimensions: ['page'],
        rowLimit: 2000,
        orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
      },
    });
    res.json(data.rows || []);
  } catch (err) {
    console.error('URLs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cwv-bulk — fetch CrUX CWV data for multiple URLs
router.post('/cwv-bulk', async (req, res) => {
  const { urls, formFactor } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required' });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });

  const cruxUrl = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${apiKey}`;

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const body = { url };
      if (formFactor) body.formFactor = formFactor;

      try {
        const { data } = await axios.post(cruxUrl, body);
        return { url, metrics: data.record?.metrics || null, source: 'url' };
      } catch (urlErr) {
        console.error('CrUX URL error:', url, urlErr.response?.data || urlErr.message);
        // fallback to origin-level
        try {
          const origin = new URL(url).origin;
          const { data } = await axios.post(cruxUrl, { origin, ...(formFactor && { formFactor }) });
          return { url, metrics: data.record?.metrics || null, source: 'origin' };
        } catch (originErr) {
          console.error('CrUX origin error:', url, originErr.response?.data || originErr.message);
          return { url, metrics: null, source: 'none' };
        }
      }
    })
  );

  const cwvData = results.map((r) => (r.status === 'fulfilled' ? r.value : { url: '', metrics: null, source: 'error' }));
  res.json(cwvData);
});

// POST /api/cwv-history — fetch & aggregate CrUX history across multiple URLs weighted by impressions
// Accepts { url, topUrls: [{url, impressions}], formFactor }
router.post('/cwv-history', async (req, res) => {
  const { url, topUrls, formFactor } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });

  const historyEndpoint = `https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=${apiKey}`;

  // Fetch history for top 50 URLs (soft cap to stay within quota), fallback weight=1 if no impressions given
  const urlList = topUrls?.length
    ? topUrls.slice(0, 50)
    : [{ url, impressions: 1 }];

  const fetched = await Promise.all(
    urlList.map(async ({ url: u, impressions }) => {
      try {
        const { data } = await axios.post(historyEndpoint, { url: u, ...(formFactor && { formFactor }) });
        return { url: u, impressions, record: data.record };
      } catch {
        return { url: u, impressions, record: null };
      }
    })
  );

  // Only keep URLs that actually have non-null density data (not just a metrics object)
  const hasRealData = (record) => {
    if (!record?.metrics) return false;
    return Object.values(record.metrics).some((m) =>
      m?.histogramTimeseries?.some((bucket) =>
        bucket.densities?.some((d) => d !== null && d !== undefined && !isNaN(Number(d)))
      )
    );
  };
  const withData = fetched.filter((f) => hasRealData(f.record));

  console.log(`[history] fetched=${fetched.length} withData=${withData.length}`);
  if (withData.length > 0) {
    const sampleMetric = Object.keys(withData[0].record.metrics)[0];
    const sampleData = withData[0].record.metrics[sampleMetric];
    const periods = withData[0].record.collectionPeriods?.length;
    const sampleDensities = sampleData.histogramTimeseries?.[0]?.densities?.slice(-5);
    console.log(`[history] url=${withData[0].url} periods=${periods} metric="${sampleMetric}" densities(last5)=${JSON.stringify(sampleDensities)}`);
    withData.forEach((u, i) => console.log(`[history]   url[${i}] periods=${u.record.collectionPeriods?.length} url=${u.url.replace('https://www.ambitionbox.com','')}`));
  }

  // Fallback to origin if no URL-level history
  if (!withData.length) {
    try {
      const origin = new URL(url).origin;
      const { data } = await axios.post(historyEndpoint, { origin, ...(formFactor && { formFactor }) });
      return res.json({ source: 'origin', data });
    } catch (err) {
      console.error('CrUX history error:', err.response?.data || err.message);
      return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
    }
  }

  // Aggregate history across all URLs with data
  const aggregated = aggregateHistoryMetrics(withData);
  return res.json({ source: 'aggregated', data: aggregated });
});

// GET /api/url-groups?siteUrl=&formFactor= — group top 1000 URLs by pattern, fetch CWV per group
router.get('/url-groups', async (req, res) => {
  const accessToken = getAccessToken(req);
  if (!accessToken) return res.status(401).json({ error: 'Missing access token' });

  const { siteUrl, formFactor } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });

  try {
    const auth = getAuth(accessToken);
    const webmasters = google.webmasters({ version: 'v3', auth });

    const end = new Date().toISOString().split('T')[0];
    const start = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      return d.toISOString().split('T')[0];
    })();

    const { data } = await webmasters.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: start,
        endDate: end,
        dimensions: ['page'],
        rowLimit: 3000,
        orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
      },
    });

    const rows = (data.rows || []).map((r) => ({
      url: r.keys[0],
      impressions: r.impressions || 0,
      clicks: r.clicks || 0,
    }));

    if (!rows.length) return res.json([]);

    const groups = groupByPattern(rows);
    const cruxEndpoint = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${apiKey}`;

    const results = await Promise.all(
      groups.map(async (group) => {
        // Fetch in batches of 10 until we have 50 URLs with actual CrUX data
        const TARGET = 50;
        const BATCH = 10;
        const withData = [];
        let urlsAttempted = 0;

        for (let offset = 0; offset < group.topUrls.length && withData.length < TARGET; offset += BATCH) {
          const batch = group.topUrls.slice(offset, offset + BATCH);
          const results = await Promise.all(
            batch.map(async ({ url, impressions }) => {
              try {
                const { data: d } = await axios.post(cruxEndpoint, { url, ...(formFactor && { formFactor }) });
                return d.record?.metrics ? { url, impressions, metrics: d.record.metrics } : null;
              } catch {
                return null;
              }
            })
          );
          urlsAttempted += batch.length;
          withData.push(...results.filter(Boolean));
        }

        const urlsFetched = urlsAttempted;
        const urlsWithData = Math.min(withData.length, TARGET);
        const finalWithData = withData.slice(0, TARGET);

        let metrics = null;
        let source = 'none';
        let usedUrl = group.sampleUrl;

        if (finalWithData.length > 0) {
          metrics = aggregateMetrics(finalWithData);
          source = 'aggregated';
          usedUrl = finalWithData[0].url;
        } else {
          // Fallback to origin
          try {
            const origin = new URL(group.sampleUrl).origin;
            const { data: d } = await axios.post(cruxEndpoint, { origin, ...(formFactor && { formFactor }) });
            metrics = d.record?.metrics || null;
            source = 'origin';
          } catch { /* no data */ }
        }

        return {
          ...group,
          metrics,
          source,
          usedUrl,
          urlsFetched,
          urlsWithData,
          sampleUrls: group.topUrls.slice(0, 5).map((u) => u.url),
          topUrls: group.topUrls,
        };
      })
    );

    res.json(results);
  } catch (err) {
    console.error('URL groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function groupByPattern(rows) {
  const parsed = rows.map((item) => {
    try {
      const u = new URL(item.url);
      return { ...item, segments: u.pathname.split('/').filter(Boolean) };
    } catch {
      return { ...item, segments: [] };
    }
  });

  const subgroups = {};
  parsed.forEach((item) => {
    const key = `${item.segments.length}|${item.segments[0] || ''}`;
    if (!subgroups[key]) subgroups[key] = [];
    subgroups[key].push(item);
  });

  const patternMap = {};

  Object.values(subgroups).forEach((group) => {
    const segLen = group[0].segments.length;
    const dynamicPos = new Set();

    for (let i = 0; i < segLen; i++) {
      const vals = new Set(group.map((g) => g.segments[i] || ''));
      if (vals.size > 1) dynamicPos.add(i);
    }

    group.forEach((item) => {
      const pattern = '/' + item.segments.map((s, i) => (dynamicPos.has(i) ? '[*]' : s)).join('/') || '/';

      if (!patternMap[pattern]) {
        patternMap[pattern] = {
          pattern,
          population: 0,
          totalImpressions: 0,
          totalClicks: 0,
          sampleUrl: item.url,
          topUrls: [], // {url, impressions} sorted by impressions desc
        };
      }
      patternMap[pattern].population++;
      patternMap[pattern].totalImpressions += item.impressions;
      patternMap[pattern].totalClicks += item.clicks;
      // Keep top 200 by impressions (rows already sorted desc) — enough candidates to find 50 with CrUX data
      if (patternMap[pattern].topUrls.length < 200) {
        patternMap[pattern].topUrls.push({ url: item.url, impressions: item.impressions });
      }
    });
  });

  return Object.values(patternMap).sort((a, b) => b.totalImpressions - a.totalImpressions);
}

// Aggregate CrUX histograms from multiple URLs, weighted by impressions, then compute p75
function aggregateMetrics(urlDataList) {
  const METRIC_KEYS = [
    'largest_contentful_paint',
    'interaction_to_next_paint',
    'cumulative_layout_shift',
    'first_contentful_paint',
    'experimental_time_to_first_byte',
  ];

  const result = {};

  for (const metricKey of METRIC_KEYS) {
    const withMetric = urlDataList.filter((u) => u.metrics?.[metricKey]?.histogram?.length);
    if (!withMetric.length) continue;

    const metricWeight = withMetric.reduce((s, u) => s + u.impressions, 0);

    // Use bucket structure from first URL (CrUX uses fixed buckets per metric)
    const buckets = withMetric[0].metrics[metricKey].histogram.map((b) => ({
      start: Number(b.start),
      end: b.end != null ? Number(b.end) : null,
      density: 0,
    }));

    // Weighted sum of densities
    for (const u of withMetric) {
      const h = u.metrics[metricKey].histogram;
      const w = u.impressions / metricWeight;
      h.forEach((bucket, i) => {
        if (buckets[i]) buckets[i].density += (bucket.density || 0) * w;
      });
    }

    // Compute p75 from the merged histogram via interpolation
    let cumulative = 0;
    let p75 = null;
    for (const bucket of buckets) {
      const prev = cumulative;
      cumulative += bucket.density;
      if (p75 === null && cumulative >= 0.75) {
        if (bucket.end != null) {
          // Interpolate within this bucket
          const frac = bucket.density > 0 ? (0.75 - prev) / bucket.density : 0;
          p75 = bucket.start + frac * (bucket.end - bucket.start);
        } else {
          // Last open-ended bucket — use start as lower bound
          p75 = bucket.start;
        }
      }
    }

    result[metricKey] = { histogram: buckets, percentiles: { p75 } };
  }

  return result;
}

// Aggregate CrUX history timeseries across multiple URLs weighted by impressions
// Returns a fake CrUX-like response with aggregated percentilesTimeseries.p75s per metric per period
function aggregateHistoryMetrics(urlDataList) {
  const METRIC_KEYS = [
    'largest_contentful_paint',
    'interaction_to_next_paint',
    'cumulative_layout_shift',
    'first_contentful_paint',
    'experimental_time_to_first_byte',
  ];

  // Use collection periods from the URL with the most periods
  const longest = urlDataList.reduce((a, b) =>
    (a.record.collectionPeriods?.length || 0) >= (b.record.collectionPeriods?.length || 0) ? a : b
  );
  const collectionPeriods = longest.record.collectionPeriods || [];
  const numPeriods = collectionPeriods.length;

  const metrics = {};

  for (const metricKey of METRIC_KEYS) {
    const p75s = [];

    for (let i = 0; i < numPeriods; i++) {
      // Collect all URLs that have histogram data for this period
      // IMPORTANT: shorter URLs are aligned from the END (most recent period)
      // e.g. if global has 25 periods and this URL has 10, its densities[0] = global period 15
      const periodData = urlDataList
        .map(({ impressions, record }) => {
          const histogram = record.metrics?.[metricKey]?.histogramTimeseries;
          if (!histogram?.length) return null;
          const urlPeriods = record.collectionPeriods?.length || numPeriods;
          const offset = numPeriods - urlPeriods; // align from the end
          const localIdx = i - offset;
          if (localIdx < 0) return null; // this URL doesn't have data this far back
          const buckets = histogram.map((bucket) => {
            const raw = bucket.densities?.[localIdx];
            const density = (raw === null || raw === undefined || isNaN(Number(raw))) ? null : Number(raw);
            return {
              start: Number(bucket.start),
              end: bucket.end != null ? Number(bucket.end) : null,
              density,
            };
          });
          // Skip this URL for this period if all densities are null/NaN
          if (buckets.every((b) => b.density === null)) return null;
          // Normalize buckets so they sum to 1 (handle partial NaN periods)
          const bucketSum = buckets.reduce((s, b) => s + (b.density || 0), 0);
          if (bucketSum <= 0) return null;
          const normalized = buckets.map((b) => ({ ...b, density: (b.density || 0) / bucketSum }));
          return { impressions, buckets: normalized };
        })
        .filter(Boolean);

      if (!periodData.length) {
        p75s.push(null);
        continue;
      }

      const totalWeight = periodData.reduce((s, u) => s + u.impressions, 0);

      // Weighted merge of bucket densities
      const merged = periodData[0].buckets.map((b, bi) => ({
        start: b.start,
        end: b.end,
        density: periodData.reduce((sum, u) => sum + (u.buckets[bi]?.density || 0) * (u.impressions / totalWeight), 0),
      }));

      // Compute p75 via interpolation
      let cumulative = 0;
      let p75 = null;
      for (const bucket of merged) {
        const prev = cumulative;
        cumulative += bucket.density;
        if (p75 === null && cumulative >= 0.75) {
          if (bucket.end != null) {
            const frac = bucket.density > 0 ? (0.75 - prev) / bucket.density : 0;
            p75 = bucket.start + frac * (bucket.end - bucket.start);
          } else {
            p75 = bucket.start;
          }
        }
      }

      p75s.push(p75);
    }

    console.log(`[history agg] ${metricKey}:`, p75s.map(v => v === null ? 'N' : (metricKey === 'cumulative_layout_shift' ? v.toFixed(4) : Math.round(v))).join(','));
    metrics[metricKey] = { percentilesTimeseries: { p75s } };
  }

  return { record: { collectionPeriods, metrics } };
}

module.exports = router;
