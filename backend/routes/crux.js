const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const CRUX_HISTORY = 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord';

router.get('/crux-history', async (req, res) => {
  const { url, formFactor } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });

  const body = { url };
  if (formFactor === 'PHONE' || formFactor === 'DESKTOP') body.formFactor = formFactor;

  try {
    const { data } = await axios.post(`${CRUX_HISTORY}?key=${apiKey}`, body, { timeout: 15000 });

    const metrics = data.record?.metrics || {};
    const periods = data.record?.collectionPeriods || [];

    const lcpP75 = metrics.largest_contentful_paint?.percentilesTimeseries?.p75s || [];
    const clsP75 = metrics.cumulative_layout_shift?.percentilesTimeseries?.p75s  || [];
    const inpP75 = metrics.interaction_to_next_paint?.percentilesTimeseries?.p75s || [];

    const points = periods.map(({ lastDate: d }, i) => ({
      date: `${d.year}-${String(d.month).padStart(2,'0')}-${String(d.day).padStart(2,'0')}`,
      lcp:  lcpP75[i] != null ? Math.round(lcpP75[i]) : null,
      cls:  clsP75[i] != null ? parseFloat(parseFloat(clsP75[i]).toFixed(3)) : null,
      inp:  inpP75[i] != null ? Math.round(inpP75[i]) : null,
    })).filter(p => p.lcp != null || p.cls != null || p.inp != null);

    res.json({
      url: data.record?.key?.url || url,
      formFactor: data.record?.key?.formFactor || 'ALL',
      points,
    });
  } catch (e) {
    const status = e.response?.status;
    const msg    = e.response?.data?.error?.message || e.message;
    if (status === 404) {
      return res.status(404).json({ error: 'No CrUX data for this URL. The page may have too little traffic, or try the origin (e.g. https://www.ambitionbox.com).' });
    }
    res.status(status || 500).json({ error: msg });
  }
});

module.exports = router;
